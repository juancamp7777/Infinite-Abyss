import type { Metadata } from "next";
import { WebchatEmbed } from "./WebchatEmbed";

export const metadata: Metadata = { title: "Chat de soporte", robots: { index: false } };

/** Webchat a página completa para embeber con public/webchat.js: /webchat?op=<operatorId>. */
export default async function WebchatPage({ searchParams }: { searchParams: Promise<{ op?: string | string[] }> }) {
  const { op } = await searchParams;
  return <WebchatEmbed op={typeof op === "string" ? op.slice(0, 100) : ""} />;
}
