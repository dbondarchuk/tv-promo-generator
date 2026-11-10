import { DEFAULT_SETTINGS, type AppSettings } from "@promo/shared";
import assert from "node:assert/strict";
import test from "node:test";
import type { JobQueue } from "./jobs.js";
import { RegenScheduler } from "./scheduler.js";

function settings(partial: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    etvDatabase: "/tmp/mock-etv.db",
    promoDeliveryMode: "remote-stream",
    voiceEnabled: true,
    voPrewarmMode: "sessions",
    ...partial,
  };
}

function mockJobs() {
  const vo: string[] = [];
  const gen: string[] = [];
  const jobs = {
    hasPendingGenerate: () => false,
    hasPendingVoPrewarm: () => false,
    enqueue: (opts: { channelNumber: string }) => {
      gen.push(opts.channelNumber);
    },
    enqueueVoPrewarm: (opts: { channelNumber: string }) => {
      vo.push(opts.channelNumber);
    },
  } as unknown as JobQueue;

  return { jobs, vo, gen };
}

function mockDbDeps(channels: Array<{ number: string; name: string }>) {
  const closed: { value: boolean } = { value: false };
  const db = {
    close: () => {
      closed.value = true;
    },
  };

  return {
    closed,
    deps: {
      openDb: () => db,
      listChannelNumbers: () => channels,
      getCurrentPrimaryItem: (
        _db: unknown,
        channelNumber: string,
      ): { mediaItemId: number; start: string } | null => {
        if (channelNumber === "idle") return null;

        return {
          mediaItemId: Number(channelNumber) || 1,
          start: `2026-01-01 00:0${channelNumber}:00`,
        };
      },
      loadChannelOverrides: () => ({}),
      fetchActiveSessions: async () => new Set<string>(),
    },
  };
}

test("scheduler sessions mode enqueues only active channels on primary change", async () => {
  const { jobs, vo } = mockJobs();
  const { deps, closed } = mockDbDeps([
    { number: "1", name: "One" },
    { number: "2", name: "Two" },
  ]);

  deps.fetchActiveSessions = async () => new Set(["2"]);

  const scheduler = new RegenScheduler(() => settings(), jobs, deps);
  await scheduler.tick();

  assert.deepEqual(vo, ["2"]);
  assert.equal(closed.value, true);
});

test("scheduler sessions mode enqueues when session newly appears", async () => {
  const { jobs, vo } = mockJobs();
  const { deps } = mockDbDeps([{ number: "1", name: "One" }]);
  const active = { current: new Set<string>(["1"]) };
  deps.fetchActiveSessions = async () => active.current;

  const scheduler = new RegenScheduler(() => settings(), jobs, deps);
  await scheduler.tick();
  assert.deepEqual(vo, ["1"]);

  vo.length = 0;
  await scheduler.tick();
  assert.deepEqual(vo, [], "same primary + still active → no re-enqueue");

  active.current = new Set();
  await scheduler.tick();
  assert.deepEqual(vo, []);

  active.current = new Set(["1"]);
  await scheduler.tick();
  assert.deepEqual(vo, ["1"], "session reappeared → enqueue");
});

test("scheduler off mode never auto-enqueues VO", async () => {
  const { jobs, vo } = mockJobs();
  const { deps } = mockDbDeps([{ number: "1", name: "One" }]);
  deps.fetchActiveSessions = async () => new Set(["1"]);

  const scheduler = new RegenScheduler(
    () => settings({ voPrewarmMode: "off" }),
    jobs,
    deps,
  );

  await scheduler.tick();
  assert.deepEqual(vo, []);
});

test("scheduler schedule mode enqueues all channels with primaries", async () => {
  const { jobs, vo } = mockJobs();
  const { deps } = mockDbDeps([
    { number: "1", name: "One" },
    { number: "2", name: "Two" },
  ]);

  deps.fetchActiveSessions = async () => {
    throw new Error("should not fetch sessions in schedule mode");
  };

  const scheduler = new RegenScheduler(
    () => settings({ voPrewarmMode: "schedule" }),
    jobs,
    deps,
  );

  await scheduler.tick();
  assert.deepEqual(vo, ["1", "2"]);
});

test("scheduler file mode enqueues generate instead of VO", async () => {
  const { jobs, vo, gen } = mockJobs();
  const { deps } = mockDbDeps([{ number: "1", name: "One" }]);

  const scheduler = new RegenScheduler(
    () => settings({ promoDeliveryMode: "file" }),
    jobs,
    deps,
  );

  await scheduler.tick();
  assert.deepEqual(vo, []);
  assert.deepEqual(gen, ["1"]);
});

test("scheduler skips disabled overrides and channels without current", async () => {
  const { jobs, vo } = mockJobs();
  const { deps } = mockDbDeps([
    { number: "1", name: "One" },
    { number: "idle", name: "Idle" },
    { number: "9", name: "Off" },
  ]);

  deps.loadChannelOverrides = () => ({
    "9": { enabled: false },
  });

  deps.fetchActiveSessions = async () => new Set(["1", "idle", "9"]);

  const scheduler = new RegenScheduler(
    () => settings({ voPrewarmMode: "schedule" }),
    jobs,
    deps,
  );

  await scheduler.tick();
  assert.deepEqual(vo, ["1"]);
});

test("scheduler skips VO when already pending", async () => {
  const vo: string[] = [];
  const jobs = {
    hasPendingGenerate: () => false,
    hasPendingVoPrewarm: (n: string) => n === "1",
    enqueue: () => undefined,
    enqueueVoPrewarm: (opts: { channelNumber: string }) => {
      vo.push(opts.channelNumber);
    },
  } as unknown as JobQueue;

  const { deps } = mockDbDeps([{ number: "1", name: "One" }]);
  const scheduler = new RegenScheduler(
    () => settings({ voPrewarmMode: "schedule" }),
    jobs,
    deps,
  );

  await scheduler.tick();
  assert.deepEqual(vo, []);
});
