/** Operations used by the atomicity and acceptance suites. Each `setup` is deterministic. */

import { ACTOR, PAGE_ID, type World } from "./world.js";

export interface Scenario {
  readonly name: string;
  readonly setup: (world: World) => Promise<void>;
  readonly run: (world: World) => Promise<{ readonly ok: boolean }>;
}

async function must(promise: Promise<{ readonly ok: boolean }>): Promise<void> {
  const result = await promise;
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result)}`);
}

const stop = (world: World) => world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });

export const SCENARIOS: readonly Scenario[] = [
  { name: "publish (first, NIHO Experience)", setup: async () => undefined, run: (world) => world.service.publish(world.input("exp")) },
  { name: "publish (first, owner's site)", setup: async () => undefined, run: (world) => world.service.publish(world.input("site")) },
  {
    name: "publish (re-publication after stop)",
    setup: async (world) => {
      await must(world.service.publish(world.input("exp")));
      await must(stop(world));
    },
    run: (world) => world.service.publish(world.input("exp")),
  },
  {
    name: "publish (stopped page on another destination)",
    setup: async (world) => {
      await must(world.service.publish(world.input("exp")));
      await must(stop(world));
    },
    run: (world) => world.service.publish(world.input("site", { slug: "coast-walk" })),
  },
  {
    name: "update (edited draft)",
    setup: async (world) => {
      await must(world.service.publish(world.input("exp")));
      world.editDraft({ title: "A morning walk, revised" });
    },
    run: (world) => world.service.update(world.input("exp")),
  },
  {
    name: "update (save: settings only)",
    setup: async (world) => {
      await must(world.service.publish(world.input("exp")));
    },
    run: (world) => world.service.update(world.input("exp", { settings: { ...world.input("exp").settings, category: "food", range: "unlisted" } })),
  },
  {
    name: "stop (face, after a move: re-points the chain)",
    setup: async (world) => {
      await must(world.service.publish(world.input("site")));
      await must(world.service.changeDestination(world.input("exp")));
    },
    run: stop,
  },
  {
    name: "stop (owner's site)",
    setup: async (world) => {
      await must(world.service.publish(world.input("site")));
    },
    run: stop,
  },
  {
    name: "changeDestination (face → site, re-pointing an older redirect)",
    setup: async (world) => {
      await must(world.service.publish(world.input("exp")));
    },
    run: (world) => world.service.changeDestination(world.input("site")),
  },
  {
    name: "changeDestination (site → face)",
    setup: async (world) => {
      await must(world.service.publish(world.input("site")));
    },
    run: (world) => world.service.changeDestination(world.input("exp")),
  },
  {
    name: "changeDestination (moving back removes a redirect)",
    setup: async (world) => {
      await must(world.service.publish(world.input("exp")));
      await must(world.service.changeDestination(world.input("site")));
    },
    run: (world) => world.service.changeDestination(world.input("exp")),
  },
  {
    name: "publish on a live page (acts as a move)",
    setup: async (world) => {
      await must(world.service.publish(world.input("exp")));
    },
    run: (world) => world.service.publish(world.input("site")),
  },
];
