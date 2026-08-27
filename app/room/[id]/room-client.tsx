"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Copy,
  Loader2,
  MonitorOff,
  MonitorUp,
  Radio,
  Users,
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
    startSharing,
    stopSharing,
  } = useWebRTC(roomId);

  const [isStarting, setIsStarting] = useState(false);

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
        <ThemeToggle />
      </header>

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
