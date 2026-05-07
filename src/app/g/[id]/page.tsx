import GameClient from "./GameClient";

export default async function GamePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ invite?: string; host?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  return (
    <GameClient
      gameId={id}
      inviteCode={sp.invite ?? null}
      isHost={sp.host === "1"}
    />
  );
}
