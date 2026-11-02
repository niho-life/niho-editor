import type { Metadata } from "next";
import { requirePhotoSession } from "@/server/session";
import { PhotoScreen } from "@/components/photo/PhotoScreen";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "写真" };

export default async function PhotoPage() {
  await requirePhotoSession("/photo");
  return <PhotoScreen />;
}
