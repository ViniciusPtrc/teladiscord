# TelaShare — Compartilhamento de tela P2P

App para compartilhar sua tela em tempo real (baixíssima latência) com amigos
via WebRTC puro, enquanto vocês conversam no Discord. Sem servidor de mídia:
o vídeo vai direto do seu navegador para o dos seus amigos.

## Stack

- Next.js 16 (App Router) + TypeScript
- Tailwind CSS v4 + shadcn/ui + lucide-react
- PeerJS (abstração sobre WebRTC)

## Como rodar localmente

```bash
npm install
npm run dev
```

Abra `http://localhost:3000`, clique em **Criar Sala** e mande o link gerado
para seus amigos (ex: cole no chat da call do Discord).

## Como funciona

- `GET /` — gera um UUID e redireciona para `/room/[id]`.
- `GET /room/[id]` — sala. Ao entrar, o navegador já tenta se conectar como
  **espectador**. Quem clicar em **Compartilhar Tela** vira o **host**: o
  navegador captura a tela via `getDisplayMedia` e sobe um peer PeerJS cujo
  ID **é o próprio ID da sala** — assim qualquer espectador consegue "ligar"
  direto para o host só sabendo o ID da URL.
- Toda a lógica de conexão (host/espectador, retries, limpeza de conexões)
  está isolada em [`hooks/useWebRTC.ts`](hooks/useWebRTC.ts).
- A sinalização (troca inicial de SDP/ICE) usa o broker público gratuito do
  PeerJS Cloud — o vídeo em si nunca passa por ele, só o "aperto de mão"
  inicial da conexão P2P. Para uso mais pesado/produção, o recomendado é
  subir seu próprio [PeerServer](https://github.com/peers/peerjs-server).
- Como fallback de rede (NAT restritivo, 4G, etc.) o hook já inclui um
  servidor STUN do Google e um TURN público (Open Relay) além da conexão
  P2P direta, para aumentar a chance de conexão bem-sucedida.

## Limitações conhecidas

- Um host por sala por vez (o segundo a clicar em "Compartilhar Tela" recebe
  um aviso de que a sala já está em uso).
- Depende de STUN/TURN públicos de terceiros — ótimo para uso casual entre
  amigos, não recomendado para produção em escala.
- Compartilhamento de tela (`getDisplayMedia`) funciona melhor no Chrome e
  Edge; Safari tem suporte parcial.
