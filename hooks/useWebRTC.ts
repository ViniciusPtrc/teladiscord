"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type Peer from "peerjs";
import type { MediaConnection, PeerError, PeerErrorType } from "peerjs";

/**
 * Servidores ICE usados pelas conexões WebRTC.
 *
 * Além do STUN público do Google, incluímos um TURN público (Open Relay)
 * como fallback para quando algum dos pares está atrás de um NAT
 * restritivo/simétrico (comum em redes de faculdade, 4G, algumas operadoras
 * de internet residencial etc.) e a conexão direta P2P não é possível.
 *
 * Para um app em produção, o ideal é rodar seu próprio TURN server, mas
 * isso é suficiente para uso entre amigos.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

const RETRY_DELAY_MS = 3000;

/**
 * Teto de bitrate de vídeo em bits/s. O WebRTC, por padrão, usa um bitrate
 * bem conservador — em telas com muito texto/UI (como um jogo de estratégia
 * ou uma planilha) isso aparece como uma imagem "borrada"/comprimida. 8 Mbps
 * dá uma nitidez bem próxima de 1080p sem exigir um upload absurdo.
 */
const MAX_VIDEO_BITRATE = 8_000_000;

/**
 * Ajusta os parâmetros de envio de vídeo de uma chamada para priorizar
 * nitidez em vez de taxa de quadros quando a rede aperta, e garante um
 * bitrate mínimo alto. Precisa ser chamado depois que a track de vídeo já
 * foi adicionada à RTCPeerConnection (ex: logo após `call.answer(stream)`).
 */
function applyHighQualityEncoding(peerConnection: RTCPeerConnection) {
  const sender = peerConnection
    .getSenders()
    .find((s) => s.track?.kind === "video");
  if (!sender) return;

  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
    // Não deixa o navegador reduzir a resolução enviada.
    params.encodings[0].scaleResolutionDownBy = 1;
    // "maintain-resolution": se a rede apertar, prefere derrubar o FPS a
    // borrar a imagem — é o oposto do padrão do navegador.
    params.degradationPreference = "maintain-resolution";
    void sender.setParameters(params);
  } catch {
    // Alguns navegadores só aceitam setParameters depois que a conexão
    // termina a negociação inicial. Não é crítico se isso falhar — só
    // ficamos sem o ganho extra de nitidez.
  }
}

export type RoomStatus =
  /** Ainda inicializando a conexão. */
  | "idle"
  /** Espectador: procurando o host da sala. */
  | "connecting"
  /** Espectador: sala existe mas o host ainda não está transmitindo. */
  | "waiting-host"
  /** Espectador: recebendo o stream normalmente. */
  | "watching"
  /** Host: transmitindo a própria tela. */
  | "sharing"
  /** Erro fatal de conexão (ex: navegador incompatível). */
  | "error";

interface UseWebRTCResult {
  /** Ref a ser passada para a tag <video> que exibe o stream (local ou remoto). */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: RoomStatus;
  /** true quando este cliente é quem está compartilhando a tela. */
  isHost: boolean;
  /** true quando existe uma transmissão ativa sendo enviada por este cliente. */
  isSharing: boolean;
  /** Número de espectadores conectados (apenas relevante para o host). */
  viewerCount: number;
  /** Mensagem de erro amigável, se houver. */
  error: string | null;
  startSharing: () => Promise<void>;
  stopSharing: () => void;
}

function friendlyPeerError(err: PeerError<`${PeerErrorType}`>): string {
  switch (err.type) {
    case "browser-incompatible":
      return "Seu navegador não suporta WebRTC. Tente usar o Chrome ou Edge.";
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed":
      return "Falha de conexão com o servidor de sinalização. Verifique sua internet.";
    default:
      return "Ocorreu um erro de conexão inesperado.";
  }
}

/**
 * Hook que encapsula toda a lógica P2P (via PeerJS) de uma sala de
 * compartilhamento de tela.
 *
 * Regras da sala:
 * - O ID da sala (roomId) é usado como ID do peer do HOST. Isso permite que
 *   qualquer espectador "ligue" diretamente para `roomId` assim que entrar.
 * - Ao montar, o cliente entra automaticamente como espectador e tenta se
 *   conectar ao host. Se o host ainda não existe, ele fica tentando de
 *   tempos em tempos (é normal — quem cria a sala ainda não clicou em
 *   "Compartilhar Tela").
 * - Quando o próprio cliente clica em "Compartilhar Tela", ele assume o
 *   papel de host: derruba sua conexão de espectador e sobe um peer com
 *   ID = roomId, respondendo a chamadas dos demais espectadores.
 */
export function useWebRTC(roomId: string): UseWebRTCResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [status, setStatus] = useState<RoomStatus>("idle");
  const [isHost, setIsHost] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const peerRef = useRef<Peer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const viewerCallRef = useRef<MediaConnection | null>(null);
  const hostCallsRef = useRef<Map<string, MediaConnection>>(new Map());
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHostRef = useRef(false);
  const mountedRef = useRef(true);

  // Funções declaradas (hoisted) para poderem se referenciar livremente sem
  // se preocupar com ordem de declaração — o fluxo de espectador/host é
  // naturalmente cíclico (ex: uma chamada que cai agenda uma nova tentativa,
  // que por sua vez pode recriar a chamada).

  function clearRetry() {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }

  function destroyPeer() {
    clearRetry();
    viewerCallRef.current?.close();
    viewerCallRef.current = null;
    hostCallsRef.current.forEach((call) => call.close());
    hostCallsRef.current.clear();
    if (peerRef.current && !peerRef.current.destroyed) {
      peerRef.current.destroy();
    }
    peerRef.current = null;
  }

  // -----------------------------------------------------------------------
  // Fluxo de ESPECTADOR
  // -----------------------------------------------------------------------

  function scheduleViewerRetry() {
    clearRetry();
    retryTimeoutRef.current = setTimeout(() => {
      if (!mountedRef.current || isHostRef.current) return;
      const peer = peerRef.current;
      if (peer && !peer.destroyed && peer.open) {
        placeCallToHost(peer);
      } else {
        void connectAsViewer();
      }
    }, RETRY_DELAY_MS);
  }

  function placeCallToHost(peer: Peer) {
    setStatus("connecting");

    // Chamada "somente recebimento": não enviamos nenhuma faixa de mídia,
    // só usamos a chamada para receber o stream do host.
    const call = peer.call(roomId, new MediaStream());
    if (!call) {
      scheduleViewerRetry();
      return;
    }
    viewerCallRef.current = call;

    call.on("stream", (remoteStream) => {
      if (!mountedRef.current) return;
      clearRetry();
      setStatus("watching");
      setError(null);
      if (videoRef.current) {
        videoRef.current.srcObject = remoteStream;
      }
    });

    call.on("close", () => {
      if (!mountedRef.current || isHostRef.current) return;
      viewerCallRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setStatus("waiting-host");
      scheduleViewerRetry();
    });

    call.on("error", () => {
      if (!mountedRef.current || isHostRef.current) return;
      setStatus("waiting-host");
      scheduleViewerRetry();
    });
  }

  async function connectAsViewer() {
    if (isHostRef.current) return;
    clearRetry();
    setStatus("connecting");

    const { default: PeerCtor } = await import("peerjs");
    if (!mountedRef.current || isHostRef.current) return;

    const peer = new PeerCtor({ config: { iceServers: ICE_SERVERS } });
    peerRef.current = peer;

    peer.on("open", () => {
      if (!mountedRef.current || isHostRef.current) return;
      placeCallToHost(peer);
    });

    peer.on("error", (err) => {
      if (!mountedRef.current || isHostRef.current) return;
      if (err.type === "peer-unavailable") {
        // O host ainda não subiu a transmissão nesta sala. Continua tentando.
        setStatus("waiting-host");
        scheduleViewerRetry();
        return;
      }
      setError(friendlyPeerError(err));
      setStatus("error");
    });

    peer.on("disconnected", () => {
      if (!mountedRef.current || isHostRef.current) return;
      if (!peer.destroyed) peer.reconnect();
    });
  }

  // -----------------------------------------------------------------------
  // Fluxo de HOST
  // -----------------------------------------------------------------------

  function stopSharing() {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    hostCallsRef.current.forEach((call) => call.close());
    hostCallsRef.current.clear();
    setViewerCount(0);

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    destroyPeer();
    isHostRef.current = false;
    setIsHost(false);
    setStatus("idle");

    // Volta a se comportar como espectador, caso alguém retome a transmissão.
    void connectAsViewer();
  }

  async function startSharing() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          // Capturar em 1080p/30fps (em vez do nativo, que pode ser 1440p/4K)
          // já ajuda bastante na nitidez: o mesmo teto de bitrate rende uma
          // imagem muito mais limpa em menos pixels.
          frameRate: { ideal: 30, max: 60 },
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
        },
        audio: {
          // Desliga processamento de áudio "de chamada" (feito pra voz),
          // que distorce música/áudio de jogo. Queremos o som do sistema
          // limpo, sem cancelamento de eco nem compressão automática.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      const domError = err as DOMException;
      if (domError?.name === "NotAllowedError") {
        toast.error("Permissão de compartilhamento de tela negada.");
      } else {
        toast.error("Não foi possível capturar sua tela.");
      }
      return;
    }

    // Derruba a conexão de espectador antes de assumir o papel de host.
    destroyPeer();

    // Sinaliza ao codificador de vídeo do navegador para priorizar
    // detalhe/nitidez em vez de suavidade de movimento — ideal para telas
    // com texto e UI (jogos de estratégia, planilhas, etc.).
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && "contentHint" in videoTrack) {
      videoTrack.contentHint = "detail";
    }

    localStreamRef.current = stream;
    isHostRef.current = true;
    setIsHost(true);
    setError(null);

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      // Muda: evita o host ouvir o próprio áudio do sistema duplicado
      // (uma vez pelo SO, outra pela tag <video> de preview).
      videoRef.current.muted = true;
    }

    // Se o usuário parar o compartilhamento pelo próprio painel do
    // navegador ("Parar apresentação"), encerramos a transmissão também.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (mountedRef.current) stopSharing();
    });

    const { default: PeerCtor } = await import("peerjs");
    if (!mountedRef.current) return;

    const peer = new PeerCtor(roomId, { config: { iceServers: ICE_SERVERS } });
    peerRef.current = peer;

    peer.on("open", () => {
      if (!mountedRef.current) return;
      setStatus("sharing");
      toast.success("Você está transmitindo sua tela!");
    });

    peer.on("call", (call) => {
      call.answer(localStreamRef.current ?? undefined);
      applyHighQualityEncoding(call.peerConnection);
      hostCallsRef.current.set(call.peer, call);
      setViewerCount(hostCallsRef.current.size);

      call.on("close", () => {
        hostCallsRef.current.delete(call.peer);
        setViewerCount(hostCallsRef.current.size);
      });
      call.on("error", () => {
        hostCallsRef.current.delete(call.peer);
        setViewerCount(hostCallsRef.current.size);
      });
    });

    peer.on("error", (err) => {
      if (!mountedRef.current) return;
      if (err.type === "unavailable-id") {
        toast.error("Alguém já está compartilhando a tela nesta sala.");
        stopSharing();
        return;
      }
      setError(friendlyPeerError(err));
      toast.error(friendlyPeerError(err));
    });

    peer.on("disconnected", () => {
      if (!mountedRef.current) return;
      if (!peer.destroyed) peer.reconnect();
    });
  }

  // -----------------------------------------------------------------------
  // Bootstrap: entra como espectador assim que a sala é montada.
  // -----------------------------------------------------------------------

  useEffect(() => {
    mountedRef.current = true;
    void connectAsViewer();

    return () => {
      mountedRef.current = false;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      destroyPeer();
    };
    // Reconecta do zero caso o ID da sala mude (navegação entre salas).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return {
    videoRef,
    status,
    isHost,
    isSharing: isHost && status === "sharing",
    viewerCount,
    error,
    startSharing,
    stopSharing,
  };
}
