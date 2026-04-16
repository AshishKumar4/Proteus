import type { ConnectionStatus } from "@/hooks/use-proteus";

const STATUS_MAP: Record<ConnectionStatus, { dot: string; text: string; label: string }> = {
  connected:    { dot: "bg-green-500",  text: "text-kumo-success", label: "Connected" },
  connecting:   { dot: "bg-yellow-500", text: "text-kumo-warning", label: "Connecting..." },
  disconnected: { dot: "bg-red-500",    text: "text-kumo-danger",  label: "Disconnected" },
  error:        { dot: "bg-red-500",    text: "text-kumo-danger",  label: "Error" },
};

export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const s = STATUS_MAP[status] ?? STATUS_MAP.disconnected;
  return (
    <div className="flex items-center gap-2" role="status">
      <span className={`size-2 rounded-full ${s.dot}`} />
      <span className={`text-xs ${s.text}`}>{s.label}</span>
    </div>
  );
}
