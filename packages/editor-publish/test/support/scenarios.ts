/** Each operation is exercised at every failing store call, through connected personal sites. */
import { ACTOR, DECLARATIONS, PAGE_ID, type World } from "./world.js";
export interface Scenario {
  readonly name: string;
  readonly setup: (world: World) => Promise<void>;
  readonly run: (world: World) => Promise<{ readonly ok: boolean }>;
}
async function must(promise: Promise<{ readonly ok: boolean }>): Promise<void> {
  if (!(await promise).ok) throw new Error("scenario setup failed");
}
const stop = (w: World) => w.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
const publish = (w: World) => w.service.publish(w.input("site"));
const second = "second-notes";
function connectSecond(w: World) {
  w.connections.connect(ACTOR, second);
  w.declarations.set(second, DECLARATIONS.site);
}
const moveInput = (w: World) => w.input("site", { target: { dest: "site", handle: second } });
const firstPublished = async (w: World) => { await must(publish(w)); };
export const SCENARIOS: readonly Scenario[] = [
  { name: "publish to a personal site", setup: async () => undefined, run: publish },
  { name: "re-publish after stop", setup: async (w) => { await firstPublished(w); await must(stop(w)); }, run: publish },
  { name: "update an edited draft", setup: async (w) => { await firstPublished(w); w.editDraft({ title: "Revised coastal walk" }); }, run: (w) => w.service.update(w.input("site")) },
  { name: "save publication settings", setup: firstPublished, run: (w) => w.service.update(w.input("site", { settings: { ...w.input("site").settings, category: "walks" } })) },
  { name: "stop a site publication", setup: firstPublished, run: stop },
  { name: "move to another connected site", setup: async (w) => { await firstPublished(w); connectSecond(w); }, run: (w) => w.service.changeDestination(moveInput(w)) },
  { name: "move back to the original site", setup: async (w) => { await firstPublished(w); connectSecond(w); await must(w.service.changeDestination(moveInput(w))); }, run: (w) => w.service.changeDestination(w.input("site")) },
  { name: "publish acts as a move", setup: async (w) => { await firstPublished(w); connectSecond(w); }, run: (w) => w.service.publish(moveInput(w)) },
];
