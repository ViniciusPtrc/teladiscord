"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import { MonitorPlay, Zap, KeyRound, Radio, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

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
      {/* Glow de fundo — duotone rosa (bebesinhas) + roxo (vagabundos) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-[15%] top-[-15%] h-[28rem] w-[28rem] rounded-full bg-fuchsia-500/25 blur-[130px]" />
        <div className="absolute right-[10%] top-[-5%] h-[26rem] w-[26rem] rounded-full bg-violet-500/25 blur-[130px]" />
        <div className="absolute bottom-[-20%] left-1/2 h-[24rem] w-[36rem] -translate-x-1/2 rounded-full bg-indigo-500/10 blur-[130px]" />
      </div>

      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <MonitorPlay className="size-5 text-fuchsia-400" />
          <span>TelaShare</span>
        </div>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
          <span className="text-sm leading-none">🍼🥴</span>
          o ponto de encontro oficial das bebesinhas e dos vagabundos
        </div>

        <h1 className="max-w-2xl text-balance text-4xl font-bold tracking-tight sm:text-6xl">
          Cola a tela.{" "}
          <span className="bg-gradient-to-r from-fuchsia-400 via-violet-400 to-indigo-400 bg-clip-text text-transparent">
            Sem lag, sem desculpa.
          </span>
        </h1>

        <p className="mt-5 max-w-lg text-balance text-muted-foreground sm:text-lg">
          Cria a sala, joga o link na call do Discord e todo mundo assiste
          junto — TFT, filme, sei lá. Direto do seu PC pro dos outros, sem
          passar por servidor no meio.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Button
            size="lg"
            className="h-12 gap-2 border-0 bg-gradient-to-r from-fuchsia-500 to-violet-600 px-8 text-base text-white hover:opacity-90"
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
            accent="fuchsia"
            title="Zero delay"
            description="P2P direto entre os pares — ninguém perde highlight por causa de buffer."
          />
          <Feature
            icon={<KeyRound className="size-4" />}
            accent="violet"
            title="Sem cadastro"
            description="Cria, copia o link, manda na call. Ninguém precisa criar conta pra nada."
          />
          <Feature
            icon={<Radio className="size-4" />}
            accent="indigo"
            title="Só quem tem o link"
            description="Sua tela só vai pra quem entrar na sala — sem gente de fora bisbilhotando."
          />
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-xs text-muted-foreground">
        Funciona melhor no Chrome ou Edge · manda o link na call e bora
      </footer>
    </div>
  );
}

const accentClasses = {
  fuchsia: "bg-fuchsia-500/10 text-fuchsia-400",
  violet: "bg-violet-500/10 text-violet-400",
  indigo: "bg-indigo-500/10 text-indigo-400",
} as const;

function Feature({
  icon,
  title,
  description,
  accent,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  accent: keyof typeof accentClasses;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card/40 p-5 text-center backdrop-blur">
      <div
        className={cn(
          "flex size-9 items-center justify-center rounded-lg",
          accentClasses[accent],
        )}
      >
        {icon}
      </div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
