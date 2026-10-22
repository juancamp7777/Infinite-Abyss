"use client";
import { EmbeddedChat } from "@/components/webchat/ChatWidget";

export function WebchatEmbed({ op }: { op: string }) {
  return <EmbeddedChat operatorId={op || undefined} />;
}
