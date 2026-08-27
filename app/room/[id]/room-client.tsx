"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bug,
  Copy,
  Loader2,
  MonitorOff,
  MonitorUp,
  Radio,
  Users,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { useWebRTC } from "@/hooks/useWebRTC";
import { cn } from "@/lib/utils";

export function RoomClient({ roomId }: { roomId: string }) {
  const {
    videoRef,
    status,
    isHost,
    isSharing,
    viewerCount,
    error,
    needsUnmute,
    unmute,
    iceState,
    startSharing,
    stopSharing,
  } = useWebRTC(roomId);

  const [isStarting, setIsStarting] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [videoStats, setVideoStats] = useState<{
    readyState: number;
    videoWidth: number;
    videoHeight: number;
    paused: boolean;
    muted: boolean;
    trackCount: number;
  } | null>(null);

  // Painel de diagnóstico: só faz polling do elemento <video> enquanto
  // estiver aberto, pra não gastar ciclo nenhum durante o uso normal.
  useEffect(() => {
    if (!showDebug) return;
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const stream = video.srcObject as MediaStream | null;
      setVideoStats({
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        paused: video.paused,
        muted: video.muted,
        trackCount: stream?.getTracks().length ?? 0,
      });
    }, 500);
    return () => clearInterval(interval);
  }, [showDebug, videoRef]);

  const handleShareClick = useCallback(async () => {
    setIsStarting(true);
    try {
      await startSharing();
    } finally {
      setIsStarting(false);
    }
  }, [startSharing]);

  const handleCopyLink = useCallback(async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copiado! Mande para seus amigos.");
    } catch {
      // Fallback para navegadores sem suporte à Clipboard API.
      const textarea = document.createElement("textarea");
      textarea.value = url;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        toast.success("Link copiado! Mande para seus amigos.");
      } catch {
        toast.error("Não foi possível copiar o link automaticamente.");
      } finally {
        document.body.removeChild(textarea);
      }
    }
  }, []);

  const showWaitingOverlay =
    !isSharing && (status === "connecting" || status === "waiting-host" || status === "idle");

  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Voltar para o início"
            nativeButton={false}
            render={<Link href="/" />}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-muted-foreground">
              Sala {roomId}
            </p>
            <StatusIndicator status={status} isSharing={isSharing} viewerCount={viewerCount} />
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Diagnóstico da conexão"
            onClick={() => setShowDebug((v) => !v)}
          >
            <Bug className="size-4" />
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {showDebug && (
        <div className="border-b border-border bg-card/60 px-4 py-2 font-mono text-[11px] text-muted-foreground sm:px-6">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>status: {status}</span>
            <span>isHost: {String(isHost)}</span>
            <span>viewerCount: {viewerCount}</span>
            <span>iceState: {iceState}</span>
            <span>needsUnmute: {String(needsUnmute)}</span>
            {videoStats && (
              <>
                <span>video.readyState: {videoStats.readyState}</span>
                <span>
                  video.size: {videoStats.videoWidth}x{videoStats.videoHeight}
                </span>
                <span>video.paused: {String(videoStats.paused)}</span>
                <span>video.muted: {String(videoStats.muted)}</span>
                <span>tracks: {videoStats.trackCount}</span>
              </>
            )}
          </div>
        </div>
      )}

      <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-black p-2 sm:p-4">
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-zinc-950">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={isHost}
            className={cn(
              "h-full w-full object-contain transition-opacity",
              showWaitingOverlay ? "opacity-0" : "opacity-100",
            )}
          />

          {isSharing && (
            <div className="absolute left-3 top-3 flex items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full bg-red-600/90 px-2.5 py-1 text-xs font-medium text-white shadow">
                <Radio className="size-3" />
                AO VIVO
              </span>
              <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white shadow backdrop-blur">
                <Users className="size-3" />
                {viewerCount}
              </span>
            </div>
          )}

          {showWaitingOverlay && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <div>
                <p className="font-medium text-foreground">
                  {status === "waiting-host"
                    ? "Ninguém está transmitindo ainda"
                    : "Conectando à sala..."}
                </p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  {status === "waiting-host"
                    ? "Assim que alguém clicar em “Compartilhar Tela” aqui, o vídeo aparece automaticamente."
                    : "Procurando o host desta sala."}
                </p>
              </div>
            </div>
          )}

          {needsUnmute && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Button onClick={unmute} className="gap-2 rounded-full shadow-lg">
                <Volume2 className="size-4" />
                Ativar som
              </Button>
            </div>
          )}

          {status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 px-6 text-center">
              <p className="font-medium text-destructive">
                {error ?? "Ocorreu um erro de conexão."}
              </p>
              <Button variant="outline" onClick={() => window.location.reload()}>
                Recarregar página
              </Button>
            </div>
          )}
        </div>
      </main>

      <footer className="flex items-center justify-center border-t border-border bg-card/40 px-4 py-4">
        <div className="flex flex-wrap items-center justify-center gap-2 rounded-full border border-border bg-card px-2 py-2 shadow-sm">
          {isSharing ? (
            <Button
              variant="destructive"
              className="gap-2 rounded-full"
              onClick={stopSharing}
            >
              <MonitorOff className="size-4" />
              Parar Transmissão
            </Button>
          ) : (
            <Button
              className="gap-2 rounded-full"
              onClick={handleShareClick}
              disabled={isStarting}
            >
              <MonitorUp className="size-4" />
              {isStarting ? "Abrindo captura..." : "Compartilhar Tela"}
            </Button>
          )}

          <Button
            variant="secondary"
            className="gap-2 rounded-full"
            onClick={handleCopyLink}
          >
            <Copy className="size-4" />
            Copiar Link
          </Button>
        </div>
      </footer>
    </div>
  );
}

function StatusIndicator({
  status,
  isSharing,
  viewerCount,
}: {
  status: string;
  isSharing: boolean;
  viewerCount: number;
}) {
  if (isSharing) {
    return (
      <p className="flex items-center gap-1.5 text-sm">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-red-500" />
        </span>
        Transmitindo · {viewerCount}{" "}
        {viewerCount === 1 ? "espectador" : "espectadores"}
      </p>
    );
  }

  if (status === "watching") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-emerald-500">
        <span className="size-2 rounded-full bg-emerald-500" />
        Assistindo
      </p>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <span className="size-2 rounded-full bg-muted-foreground/50" />
      {status === "waiting-host" ? "Aguardando host" : "Conectando..."}
    </p>
  );
}
