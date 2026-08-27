"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import { MonitorPlay, Zap, Users, ShieldCheck, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export default function Home() {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);

  function handleCreateRoom() {
    setIsCreating(true);
    const roomId = uuidv4();
    router.push(`/room/${roomId}`);
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-background">
      {/* Glow de fundo */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
      >
        <div className="absolute left-1/2 top-[-10%] h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-primary/20 blur-[120px]" />
        <div className="absolute bottom-[-15%] right-[-10%] h-[24rem] w-[24rem] rounded-full bg-primary/10 blur-[120px]" />
      </div>

      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <MonitorPlay className="size-5 text-primary" />
          <span>TelaShare</span>
        </div>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          Conexão direta P2P via WebRTC
        </div>

        <h1 className="max-w-2xl text-balance text-4xl font-bold tracking-tight sm:text-6xl">
          Compartilhe sua tela.{" "}
          <span className="bg-gradient-to-r from-primary to-primary/50 bg-clip-text text-transparent">
            Sem delay.
          </span>
        </h1>

        <p className="mt-5 max-w-lg text-balance text-muted-foreground sm:text-lg">
          Crie uma sala, mande o link para a call do Discord e assista TFT,
          filmes ou qualquer coisa junto — o vídeo vai direto do seu PC para o
          dos seus amigos, sem passar por servidor.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Button
            size="lg"
            className="h-12 gap-2 px-8 text-base"
            onClick={handleCreateRoom}
            disabled={isCreating}
          >
            {isCreating ? "Criando sala..." : "Criar Sala"}
            <ArrowRight className="size-4" />
          </Button>
        </div>

        <div className="mt-16 grid w-full max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
          <Feature
            icon={<Zap className="size-4" />}
            title="Latência mínima"
            description="Transmissão P2P direta entre os pares, sem re-encode em servidor."
          />
          <Feature
            icon={<Users className="size-4" />}
            title="Sem cadastro"
            description="Crie a sala, copie o link e mande para a call. Só isso."
          />
          <Feature
            icon={<ShieldCheck className="size-4" />}
            title="Privado"
            description="Sua tela só é enviada para quem entrar com o link da sala."
          />
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-xs text-muted-foreground">
        Funciona melhor no Chrome ou Edge. Peça para seus amigos abrirem o
        link enquanto vocês conversam no Discord.
      </footer>
    </div>
  );
}

function Feature({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card/40 p-5 text-center backdrop-blur">
      <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
