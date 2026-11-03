import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GoogleDocsBatchView } from "@/components/GoogleDocsBatchView";

export const metadata: Metadata = { title: "Google ドキュメントへ書き出す" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function GoogleDocsBatchPage({ params }: { params: Promise<{ rootPageId: string }> }) {
  const { rootPageId } = await params;
  if (!UUID.test(rootPageId)) notFound();
  return <GoogleDocsBatchView rootPageId={rootPageId.toLowerCase()} />;
}
