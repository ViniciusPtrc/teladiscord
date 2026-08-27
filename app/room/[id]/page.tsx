import { RoomClient } from "./room-client";

export default async function RoomPage({ params }: PageProps<"/room/[id]">) {
  const { id } = await params;

  return <RoomClient roomId={id} />;
}
