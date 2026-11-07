import { notFoundResponse } from "@/server/http";

export function GET(): Response {
  return notFoundResponse();
}
