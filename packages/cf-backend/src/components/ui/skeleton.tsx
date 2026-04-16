import type { HTMLAttributes } from "react";

function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`animate-pulse rounded-lg bg-kumo-line/30 ${className ?? ""}`} {...props} />;
}

export { Skeleton };
