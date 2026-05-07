import { adminClient } from "./supabase";

// Server-side: publish a broadcast event to game:<gameId>.
// Clients subscribed to that topic receive it and re-fetch authoritative state.
// We deliberately keep the payload empty — broadcasts are pings, not state.
// (Threat model: anyone holding the gameId UUID can also publish to the same
// channel, so payloads cannot be trusted as source of truth.)

export async function broadcastGameUpdate(gameId: string): Promise<void> {
  const sb = adminClient();
  const channel = sb.channel(`game:${gameId}`);
  try {
    await channel.send({
      type: "broadcast",
      event: "update",
      payload: { ts: Date.now() },
    });
  } catch (err) {
    // Best-effort; clients also poll as a fallback.
    console.warn("[realtime] broadcast failed", err);
  } finally {
    await sb.removeChannel(channel).catch(() => {});
  }
}
