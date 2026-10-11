// acmi-adapter.mjs — an ACMI AcmiAdapter backed by the LogMem store.
//
// This is what "compat mode passes ACMI conformance" means concretely: the
// ACMI suite (@madezmedia/acmi/testing/conformance) drives this adapter, and
// every byte it stores is LogMem-shaped (lm:{space}:* keys, trail/origin/by
// fields, LogMem kinds). Reads translate back to ACMI shape.

import { createStore } from "../core/store.mjs";
import { entryFromAcmi, entryToAcmi } from "../core/vocab.mjs";

function split(entityId) {
  const s = String(entityId);
  const i = s.indexOf(":");
  return { ns: s.slice(0, i), id: s.slice(i + 1) };
}

export class LogmemAcmiAdapter {
  constructor(redis, { space = "madez", name = "logmem-compat" } = {}) {
    this.name = name;
    this.store = createStore(redis, { space, compat: false });
  }

  async profileGet(entityId) {
    const { ns, id } = split(entityId);
    return this.store.getWho(ns, id);
  }
  async profileSet(entityId, doc) {
    const { ns, id } = split(entityId);
    await this.store.setWho(ns, id, doc);
  }
  async profileMerge(entityId, partial) {
    const { ns, id } = split(entityId);
    return this.store.mergeWho(ns, id, partial);
  }
  async profileDelete(entityId) {
    const { ns, id } = split(entityId);
    await this.store.deleteWho(ns, id);
  }

  async signalsGet(entityId, key) {
    const { ns, id } = split(entityId);
    const all = await this.store.getNow(ns, id);
    return Object.hasOwn(all, key) ? all[key] : undefined;
  }
  async signalsSet(entityId, key, value) {
    const { ns, id } = split(entityId);
    await this.store.setNow(ns, id, { [key]: value });
  }
  async signalsAll(entityId) {
    const { ns, id } = split(entityId);
    return this.store.getNow(ns, id);
  }
  async signalsDelete(entityId, key) {
    const { ns, id } = split(entityId);
    await this.store.deleteNow(ns, id, key);
  }

  async timelineAppend(entityId, event) {
    const { ns, id } = split(entityId);
    await this.store.append(ns, id, entryFromAcmi(event));
  }
  async timelineRead(entityId, opts = {}) {
    const { ns, id } = split(entityId);
    const entries = await this.store.readLog(ns, id, opts);
    return entries.map(entryToAcmi);
  }
  async timelineSize(entityId) {
    const { ns, id } = split(entityId);
    return this.store.logSize(ns, id);
  }

  async batch(ops) {
    for (const op of ops) {
      if (op.type === "profileSet") await this.profileSet(op.entityId, op.doc);
      else if (op.type === "profileDelete") await this.profileDelete(op.entityId);
      else if (op.type === "signalsSet") await this.signalsSet(op.entityId, op.key, op.value);
      else if (op.type === "signalsDelete") await this.signalsDelete(op.entityId, op.key);
      else if (op.type === "timelineAppend") await this.timelineAppend(op.entityId, op.event);
    }
  }
}
