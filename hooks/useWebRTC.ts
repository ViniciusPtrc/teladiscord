"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type Peer from "peerjs";
import type {
  DataConnection,
  MediaConnection,
  PeerError,
  PeerErrorType,
} from "peerjs";

/**
 * Servidores STUN públicos usados como base — ajudam dois pares a descobrir
 * seus endereços públicos, mas sozinhos NÃO atravessam NATs restritivos
 * (comum em redes 4G, CGNAT de operadoras residenciais, redes corporativas
 * etc.). Nesses casos é obrigatório um relay TURN — ver `getIceServers`.
 */
const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Credenciais TURN gratuitas do Open Relay Project (via metered.ca).
 *
 * Diferente do STUN, um TURN precisa de credenciais válidas e com cota —
 * por isso são geradas dinamicamente a partir de uma conta gratuita
 * (NEXT_PUBLIC_METERED_APP_NAME / NEXT_PUBLIC_METERED_API_KEY no .env.local),
 * em vez de usar credenciais estáticas/compartilhadas publicadas em
 * tutoriais (essas ficam sobrecarregadas e não são confiáveis). Sem essas
 * variáveis configuradas, o app cai de volta para STUN-only, que funciona
 * bem entre a maioria das redes residenciais, mas pode falhar quando algum
 * dos dois lados está atrás de um NAT mais restritivo.
 */
let cachedIceServersPromise: Promise<RTCIceServer[]> | null = null;

async function getIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServersPromise) return cachedIceServersPromise;

  cachedIceServersPromise = (async () => {
    const appName = process.env.NEXT_PUBLIC_METERED_APP_NAME;
    const apiKey = process.env.NEXT_PUBLIC_METERED_API_KEY;
    if (!appName || !apiKey) return STUN_SERVERS;

    try {
      const res = await fetch(
        `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`,
      );
      if (!res.ok) return STUN_SERVERS;
      const turnServers = (await res.json()) as RTCIceServer[];
      if (!Array.isArray(turnServers) || turnServers.length === 0) {
        return STUN_SERVERS;
      }
      return [...STUN_SERVERS, ...turnServers];
    } catch {
      return STUN_SERVERS;
    }
  })();

  return cachedIceServersPromise;
}

/**
 * Atraso das novas tentativas de conexão, com backoff exponencial (3s, 6s,
 * 12s... até um teto de 20s). Um atraso fixo e curto (ficamos com 3s fixos
 * antes) bombardeia o broker de sinalização com pedidos de WebSocket com
 * frequência alta — exatamente o tipo de padrão que aciona rate limit
 * (confirmado: `0.peerjs.com/peerjs` chegou a devolver HTTP 429 do
 * Cloudflare por causa disso). Backoff crescente reduz esse volume e ainda
 * assim recupera sozinho quando o servidor volta a aceitar conexões.
 */
const RETRY_BASE_DELAY_MS = 3000;
const RETRY_MAX_DELAY_MS = 20000;

/**
 * Tipos de erro tratados como instabilidade passageira do servidor de
 * sinalização (0.peerjs.com é um servidor de demonstração gratuito, sem
 * garantia de uptime) — vale tentar de novo antes de desistir.
 */
const TRANSIENT_ERROR_TYPES = new Set<`${PeerErrorType}`>([
  "network",
  "server-error",
  "socket-error",
  "socket-closed",
]);
const MAX_TRANSIENT_RETRIES = 5;

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
  /** true quando o vídeo está tocando mudo por bloqueio de autoplay do
   * navegador — mostrar um botão "Ativar som" que chama `unmute()`. */
  needsUnmute: boolean;
  unmute: () => void;
  /** Estado ICE da conexão principal — só para diagnóstico. */
  iceState: RTCIceConnectionState | "idle";
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
 *   ID = roomId.
 *
 * Detalhe importante do fluxo espectador→host: quem faz a *chamada* de
 * vídeo (`peer.call`) é sempre o HOST, nunca o espectador. Se o espectador
 * chamasse o host sem ter nenhuma faixa de vídeo/áudio própria pra mandar,
 * a oferta SDP nasceria sem nenhuma faixa de mídia — e o WebRTC não permite
 * adicionar faixas na resposta que não existiam na oferta original, então
 * o vídeo do host nunca chegaria (mesmo com a conexão ICE "conectada").
 * Por isso o espectador só avisa sua presença via uma conexão de dados
 * (`peer.connect`) e é o host quem liga de volta com o stream de verdade.
 */
export function useWebRTC(roomId: string): UseWebRTCResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [status, setStatus] = useState<RoomStatus>("idle");
  const [isHost, setIsHost] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** true quando o navegador bloqueou o autoplay com som e o vídeo está
   * tocando mudo até o espectador clicar em "ativar som". */
  const [needsUnmute, setNeedsUnmute] = useState(false);
  /** Último iceConnectionState conhecido da conexão principal (espectador
   * assistindo, ou host com pelo menos um espectador) — só para o painel
   * de diagnóstico, não afeta o fluxo. */
  const [iceState, setIceState] = useState<RTCIceConnectionState | "idle">("idle");

  const peerRef = useRef<Peer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  /** Conexão de dados usada só pra avisar "estou aqui" pro host (espectador). */
  const viewerHandshakeRef = useRef<DataConnection | null>(null);
  /** Chamada de vídeo recebida do host (espectador). */
  const viewerCallRef = useRef<MediaConnection | null>(null);
  /** Chamadas de vídeo que o host está enviando, por peerId do espectador. */
  const hostCallsRef = useRef<Map<string, MediaConnection>>(new Map());
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Quantas tentativas seguidas sem sucesso real (nunca chegou a
   * "watching") — usado só pra calcular o backoff crescente do delay entre
   * tentativas. Reseta quando o espectador realmente começa a assistir. */
  const retryAttemptRef = useRef(0);
  /** Conta especificamente erros de sinalização (rede/servidor) seguidos,
   * pra limitar quantas vezes tentamos de novo antes de desistir de vez e
   * mostrar erro fatal. Diferente de "sala vazia" (peer-unavailable), que
   * pode ficar tentando pra sempre — reseta assim que o peer conecta com
   * sucesso ao servidor de sinalização (evento "open"). */
  const transientErrorCountRef = useRef(0);
  const isHostRef = useRef(false);
  const mountedRef = useRef(true);

  // Funções declaradas (hoisted) para poderem se referenciar livremente sem
  // se preocupar com ordem de declaração — o fluxo de espectador/host é
  // naturalmente cíclico (ex: uma chamada que cai agenda uma nova tentativa,
  // que por sua vez pode recriar a chamada).

  /**
   * Loga mudanças de estado da conexão ICE no console — não afeta a UI,
   * mas é a forma mais rápida de diagnosticar por que uma chamada nunca
   * chega a "connected" (ex: falha de NAT/TURN) quando alguém reportar
   * problema. Abra o DevTools (F12) do lado que está travado.
   */
  function logIceState(label: string, peerConnection: RTCPeerConnection) {
    peerConnection.addEventListener("iceconnectionstatechange", () => {
      console.debug(`[useWebRTC] ${label} iceConnectionState:`, peerConnection.iceConnectionState);
      if (mountedRef.current) setIceState(peerConnection.iceConnectionState);
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      console.debug(`[useWebRTC] ${label} connectionState:`, peerConnection.connectionState);
    });
  }

  function clearRetry() {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }

  /**
   * Destrói o peer atual e só resolve quando o servidor de sinalização
   * confirma o encerramento (evento "close").
   *
   * Isso importa especialmente pro HOST: `peer.destroy()` manda o pedido de
   * encerramento pro broker do PeerJS de forma assíncrona — se o mesmo
   * usuário clicar em "Compartilhar Tela" de novo rápido demais, uma nova
   * tentativa de reivindicar `roomId` pode chegar ao servidor ANTES dele
   * processar a liberação do ID anterior, e o servidor recusa com
   * "unavailable-id" (que o app então mostra, errado, como "outra pessoa
   * já está compartilhando"). Esperar o "close" evita essa corrida.
   */
  function destroyPeer(): Promise<void> {
    clearRetry();
    viewerHandshakeRef.current?.close();
    viewerHandshakeRef.current = null;
    viewerCallRef.current?.close();
    viewerCallRef.current = null;
    hostCallsRef.current.forEach((call) => call.close());
    hostCallsRef.current.clear();

    const peer = peerRef.current;
    peerRef.current = null;

    if (!peer || peer.destroyed) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // Rede de segurança: se por algum motivo o evento "close" nunca
      // disparar, não trava o app pra sempre — só demora um pouco mais.
      const timeout = setTimeout(done, 1500);
      peer.on("close", () => {
        clearTimeout(timeout);
        done();
      });
      peer.destroy();
    });
  }

  // -----------------------------------------------------------------------
  // Fluxo de ESPECTADOR
  // -----------------------------------------------------------------------

  function scheduleViewerRetry() {
    clearRetry();
    // Backoff exponencial: cada tentativa nova espera mais que a anterior
    // (3s, 6s, 12s... até 20s), pra não bombardear o broker de sinalização
    // com pedidos de WebSocket com frequência alta.
    const delay = Math.min(
      RETRY_BASE_DELAY_MS * 2 ** retryAttemptRef.current,
      RETRY_MAX_DELAY_MS,
    );
    retryAttemptRef.current += 1;
    // Sempre recomeça do zero (peer novo, handshake novo) em vez de tentar
    // reaproveitar o peer atual — é mais lento por poucos ms, mas evita
    // qualquer estado zumbi de uma tentativa anterior que deu errado.
    retryTimeoutRef.current = setTimeout(() => {
      if (!mountedRef.current || isHostRef.current) return;
      void connectAsViewer();
    }, delay);
  }

  /** Avisa o host "estou aqui, quero assistir" — não carrega vídeo nenhum. */
  function handshakeWithHost(peer: Peer) {
    setStatus("connecting");

    const handshake = peer.connect(roomId, { reliable: true });
    viewerHandshakeRef.current = handshake;

    // Rede de segurança: se o host não retornar com uma chamada de vídeo em
    // alguns segundos, recomeça. É cancelada assim que o stream chegar
    // (ver clearRetry() dentro de handleIncomingCall).
    scheduleViewerRetry();

    handshake.on("close", () => {
      if (!mountedRef.current || isHostRef.current) return;
      viewerHandshakeRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setStatus("waiting-host");
      scheduleViewerRetry();
    });

    handshake.on("error", () => {
      if (!mountedRef.current || isHostRef.current) return;
      setStatus("waiting-host");
      scheduleViewerRetry();
    });
  }

  /** O host ligou de volta com o stream de verdade — só aceitamos. */
  function handleIncomingCall(call: MediaConnection) {
    viewerCallRef.current = call;
    call.answer();
    logIceState("espectador", call.peerConnection);

    call.on("stream", (remoteStream) => {
      if (!mountedRef.current) return;
      clearRetry();
      retryAttemptRef.current = 0;
      setStatus("watching");
      setError(null);
      setNeedsUnmute(false);

      console.debug("[REMOTE] stream:", remoteStream);
      console.debug("[REMOTE] video tracks:", remoteStream.getVideoTracks());
      console.debug("[REMOTE] audio tracks:", remoteStream.getAudioTracks());

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = remoteStream;

      // Espectador SEMPRE quer ouvir. Precisa ser explícito aqui: se este
      // mesmo cliente já foi host antes (mesmo <video>, `videoRef.current.muted
      // = true` em startSharing), o elemento continua mudo — a prop
      // `muted={isHost}` do React não é reaplicada em re-render (bug conhecido
      // do React: `muted` só vira propriedade na montagem inicial). Sem esta
      // linha, o vídeo toca sem áudio e o botão "Ativar som" nem aparece,
      // porque o play() abaixo dá certo.
      video.muted = false;

      // Tenta tocar com som. Se o navegador bloquear autoplay com áudio
      // (política padrão sem interação prévia do usuário), cai pra mudo —
      // isso sempre é permitido — e avisa a UI pra mostrar um botão de
      // "ativar som" (um clique já libera o áudio depois).
      video.play().catch(() => {
        if (!mountedRef.current) return;
        video.muted = true;
        setNeedsUnmute(true);
        void video.play();
      });
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
    // Sempre destrói qualquer peer/conexão anterior antes de criar um novo.
    // Sem isso, cada nova tentativa (a cada retry) acumula RTCPeerConnections
    // órfãs até o navegador recusar criar mais ("Cannot create so many
    // PeerConnections") — foi exatamente isso que aconteceu numa sessão
    // de teste mais longa.
    await destroyPeer();
    if (!mountedRef.current || isHostRef.current) return;
    setStatus("connecting");

    const [{ default: PeerCtor }, iceServers] = await Promise.all([
      import("peerjs"),
      getIceServers(),
    ]);
    if (!mountedRef.current || isHostRef.current) return;

    const peer = new PeerCtor({ config: { iceServers } });
    peerRef.current = peer;

    peer.on("open", () => {
      if (!mountedRef.current || isHostRef.current) return;
      transientErrorCountRef.current = 0;
      handshakeWithHost(peer);
    });

    peer.on("call", (call) => {
      if (!mountedRef.current || isHostRef.current) return;
      handleIncomingCall(call);
    });

    peer.on("error", (err) => {
      if (!mountedRef.current || isHostRef.current) return;
      if (err.type === "peer-unavailable") {
        // O host ainda não subiu a transmissão nesta sala. Continua tentando.
        setStatus("waiting-host");
        scheduleViewerRetry();
        return;
      }
      if (TRANSIENT_ERROR_TYPES.has(err.type) && transientErrorCountRef.current < MAX_TRANSIENT_RETRIES) {
        // Instabilidade passageira no servidor de sinalização (é um
        // servidor de demonstração gratuito do PeerJS, sem SLA) — tenta
        // de novo algumas vezes antes de desistir e mostrar erro fatal.
        transientErrorCountRef.current += 1;
        setStatus("connecting");
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

  async function stopSharing() {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    hostCallsRef.current.forEach((call) => call.close());
    hostCallsRef.current.clear();
    setViewerCount(0);

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    // Espera o servidor confirmar que o ID da sala foi liberado antes de
    // seguir — evita que um "Compartilhar Tela" rápido logo em seguida
    // (nosso ou de outra pessoa) esbarre num "unavailable-id" falso.
    await destroyPeer();
    if (!mountedRef.current) return;
    isHostRef.current = false;
    setIsHost(false);
    setStatus("idle");

    // Volta a se comportar como espectador, caso alguém retome a transmissão.
    void connectAsViewer();
  }

  async function startSharing() {
    // Passado como variável (não como literal inline) de propósito: assim
    // dá pra incluir `systemAudio`, uma extensão do Chrome/Edge ainda fora
    // dos tipos padrão do TypeScript, sem precisar de `as any`. Ela
    // sinaliza pro navegador incluir o áudio do sistema por padrão ao
    // compartilhar a tela inteira/uma janela (sem isso, alguns navegadores
    // só oferecem a opção de áudio quando se escolhe compartilhar uma aba
    // específica do próprio navegador).
    const captureOptions = {
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
        systemAudio: "include",
      },
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(captureOptions);
    } catch (err) {
      const domError = err as DOMException;
      if (domError?.name === "NotAllowedError") {
        toast.error("Permissão de compartilhamento de tela negada.");
      } else {
        toast.error("Não foi possível capturar sua tela.");
      }
      return;
    }

    // Diagnóstico: o pipeline (addTrack → SDP → ICE → ontrack) trata áudio
    // e vídeo exatamente da mesma forma — não existe filtro nenhum no
    // código que remova a AudioTrack. Então, se não vier áudio, a causa é
    // sempre a captura em si (checkbox "Compartilhar áudio" não marcada no
    // diálogo do navegador, ou o SO/superfície compartilhada não suporta
    // captura de áudio do sistema — ex: macOS não suporta para tela/janela,
    // só pra abas do Chrome).
    console.debug("[SCREEN] stream:", stream);
    console.debug("[SCREEN] all tracks:", stream.getTracks());
    console.debug("[SCREEN] video tracks:", stream.getVideoTracks());
    console.debug("[SCREEN] audio tracks:", stream.getAudioTracks());
    if (stream.getAudioTracks().length === 0) {
      toast.warning(
        "Compartilhando sem áudio — marque \"Compartilhar áudio\" no diálogo do navegador (ou, no Mac, isso só funciona compartilhando uma aba do Chrome).",
        { duration: 8000 },
      );
    }

    // Derruba a conexão de espectador (ou o host anterior, se veio de um
    // stopSharing()+startSharing() rápido) e SÓ SEGUE depois do servidor
    // confirmar o encerramento — é essa espera que evita o falso
    // "unavailable-id" ao tentar reivindicar `roomId` de novo rápido demais.
    await destroyPeer();
    if (!mountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

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
      if (mountedRef.current) void stopSharing();
    });

    const [{ default: PeerCtor }, iceServers] = await Promise.all([
      import("peerjs"),
      getIceServers(),
    ]);
    if (!mountedRef.current) return;

    // Tenta reivindicar `roomId` como Peer ID. Se o servidor recusar por
    // "unavailable-id" logo de cara, tenta mais algumas vezes antes de
    // concluir que é realmente outra pessoa — é uma segunda camada de
    // proteção contra a mesma corrida que o `await destroyPeer()` acima já
    // deveria ter evitado (defesa extra caso o servidor demore um pouco
    // mais que o normal pra liberar o ID anterior).
    const MAX_CLAIM_RETRIES = 2;
    const CLAIM_RETRY_DELAY_MS = 600;

    function claimHostPeer(retriesLeft: number) {
      const peer = new PeerCtor(roomId, { config: { iceServers } });
      peerRef.current = peer;

      peer.on("open", () => {
        if (!mountedRef.current) return;
        setStatus("sharing");
        toast.success("Você está transmitindo sua tela!");
      });

      // Um espectador avisa presença via conexão de dados — o host é quem
      // liga de volta com o stream de verdade (ver comentário no topo do
      // arquivo sobre por que a chamada precisa partir de quem tem a mídia).
      peer.on("connection", (dataConnection) => {
        if (!mountedRef.current || !localStreamRef.current) return;

        const call = peer.call(dataConnection.peer, localStreamRef.current);
        if (!call) return;

        applyHighQualityEncoding(call.peerConnection);
        logIceState(`espectador ${dataConnection.peer}`, call.peerConnection);
        hostCallsRef.current.set(dataConnection.peer, call);
        setViewerCount(hostCallsRef.current.size);

        const cleanup = () => {
          hostCallsRef.current.delete(dataConnection.peer);
          setViewerCount(hostCallsRef.current.size);
        };

        dataConnection.on("close", () => {
          call.close();
          cleanup();
        });
        call.on("close", cleanup);
        call.on("error", cleanup);
      });

      peer.on("error", (err) => {
        if (!mountedRef.current) return;
        if (err.type === "unavailable-id") {
          if (retriesLeft > 0) {
            setTimeout(() => {
              if (!mountedRef.current || !isHostRef.current) return;
              claimHostPeer(retriesLeft - 1);
            }, CLAIM_RETRY_DELAY_MS);
            return;
          }
          toast.error("Alguém já está compartilhando a tela nesta sala.");
          void stopSharing();
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

    claimHostPeer(MAX_CLAIM_RETRIES);
  }

  /** Chamado pelo clique do usuário no botão "Ativar som" — libera o áudio. */
  function unmute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    setNeedsUnmute(false);
    void video.play();
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
      void destroyPeer();
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
    needsUnmute,
    unmute,
    iceState,
    startSharing,
    stopSharing,
  };
}
