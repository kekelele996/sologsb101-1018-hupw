/**
 * 荫房记录状态管理（Zustand）
 * 维护荫房记录与超标派生统计；湿度越界即回写关联道次为「待复检」。
 * 新登记入房时按荫房容量（件 / 天）决定日期：当天放不下则后到的顺延第二天，
 * 值守已经记下的记录不动；每次写入后按道次重算荫干时长对账状态。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Room, RoomDraft, RoomVerdict } from '@/types/room';
import { judgeVerdict } from '@/utils/humidity';
import { readRoomCapacity, scheduleRoomDate, writeRoomCapacity } from '@/utils/capacity';
import { useCoatStore } from './coatStore';

export interface CreateRoomResult {
  room: Room;
  /** 相对登记日期顺延了几天（0 表示当天进房） */
  shiftedDays: number;
}

interface RoomStoreState {
  rooms: Room[];
  /** 荫房容量（件 / 天） */
  capacity: number;
  loading: boolean;
  ready: boolean;
  error: string;
  loadRooms: () => Promise<void>;
  setCapacity: (capacity: number) => void;
  roomsOfBody: (bodyId: string) => Room[];
  /** 新登记：按容量顺延日期，已有记录一律不动 */
  createRoom: (draft: RoomDraft) => Promise<CreateRoomResult>;
  updateRoom: (id: string, patch: Partial<Room>) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  /** 超标（偏干 / 偏湿）记录条数 */
  overCount: () => number;
  overCountOfBody: (bodyId: string) => number;
  verdictCount: () => Record<RoomVerdict, number>;
}

export const useRoomStore = create<RoomStoreState>((set, get) => ({
  rooms: [],
  capacity: readRoomCapacity(),
  loading: false,
  ready: false,
  error: '',

  async loadRooms() {
    set({ loading: true });
    try {
      const rooms = await db.rooms.toArray();
      rooms.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      set({ rooms, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '荫房记录读取失败' });
    }
  },

  setCapacity(capacity) {
    const next = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : readRoomCapacity();
    writeRoomCapacity(next);
    set({ capacity: next });
  },

  roomsOfBody(bodyId) {
    return get()
      .rooms.filter((room) => room.bodyId === bodyId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  },

  async createRoom(draft) {
    const now = Date.now();
    // 容量调度：同一天入房件数超限，后到的顺延到第二天；既有记录不参与改动
    const scheduled = scheduleRoomDate(await db.rooms.toArray(), draft.date, draft.bodyId, get().capacity);
    const date = scheduled.date;
    const verdict = judgeVerdict(draft.tempC, draft.humidityPct);
    const row: Room = { ...draft, date, verdict, id: createId('room'), createdAt: now, updatedAt: now };
    await db.rooms.put(row);
    // 越界即回写关联道次为待复检
    if (verdict !== 'suitable') {
      await useCoatStore.getState().markRecheck(row.bodyId, true);
    }
    // 按道次重算：补记的进出房一旦把缺口补平，待复检标记自动摘掉
    await useCoatStore.getState().syncDryingRecheck();
    await Promise.all([get().loadRooms(), useCoatStore.getState().loadCoats()]);
    return { room: row, shiftedDays: scheduled.shiftedDays };
  },

  async updateRoom(id, patch) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return;
    const tempC = patch.tempC ?? existing.tempC;
    const humidityPct = patch.humidityPct ?? existing.humidityPct;
    const verdict = judgeVerdict(tempC, humidityPct);
    // 已记下的记录不改日期归属：容量调度只作用于新登记
    await db.rooms.update(id, { ...patch, tempC, humidityPct, verdict, updatedAt: Date.now() } as never);
    if (verdict !== 'suitable') {
      await useCoatStore.getState().markRecheck(existing.bodyId, true);
    }
    await useCoatStore.getState().syncDryingRecheck();
    await Promise.all([get().loadRooms(), useCoatStore.getState().loadCoats()]);
  },

  async removeRoom(id) {
    await db.rooms.delete(id);
    await useCoatStore.getState().syncDryingRecheck();
    await Promise.all([get().loadRooms(), useCoatStore.getState().loadCoats()]);
  },

  overCount() {
    return get().rooms.filter((room) => room.verdict !== 'suitable').length;
  },

  overCountOfBody(bodyId) {
    return get().rooms.filter((room) => room.bodyId === bodyId && room.verdict !== 'suitable').length;
  },

  verdictCount() {
    const result: Record<RoomVerdict, number> = { suitable: 0, dry: 0, wet: 0 };
    get().rooms.forEach((room) => {
      result[room.verdict] += 1;
    });
    return result;
  },
}));
