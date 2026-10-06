/**
 * 荫房记录状态管理（Zustand）
 * 维护荫房记录与超标派生统计；湿度越界即回写关联道次为「待复检」；
 * 新登记超过荫房当日容量时后到的自动顺延到第二天（已登记的记录不动）；
 * 进出房记录变动后触发按道次荫干对账，缺口补平自动摘标。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Room, RoomDraft, RoomVerdict } from '@/types/room';
import { judgeVerdict, ROOM_DAILY_CAPACITY, shiftDate } from '@/utils/humidity';
import { useCoatStore } from './coatStore';

interface RoomStoreState {
  rooms: Room[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadRooms: () => Promise<void>;
  roomsOfBody: (bodyId: string) => Room[];
  createRoom: (draft: RoomDraft) => Promise<Room>;
  updateRoom: (id: string, patch: Partial<Room>) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  /** 超标（偏干 / 偏湿）记录条数 */
  overCount: () => number;
  overCountOfBody: (bodyId: string) => number;
  verdictCount: () => Record<RoomVerdict, number>;
}

export const useRoomStore = create<RoomStoreState>((set, get) => ({
  rooms: [],
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

  roomsOfBody(bodyId) {
    return get()
      .rooms.filter((room) => room.bodyId === bodyId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  },

  async createRoom(draft) {
    const now = Date.now();
    const verdict = judgeVerdict(draft.tempC, draft.humidityPct);
    // 容量控制：同一天要进房的件数（按胎体计，同一件进出多趟算一件）超过荫房容量时，
    // 后到的顺延到第二天；值守已记下的记录保持不动
    let date = draft.date;
    for (let guard = 0; guard < 30; guard += 1) {
      const bodiesIn = new Set(
        get()
          .rooms.filter((room) => room.date === date)
          .map((room) => room.bodyId),
      );
      if (bodiesIn.size < ROOM_DAILY_CAPACITY || bodiesIn.has(draft.bodyId)) break;
      date = shiftDate(date, 1);
    }
    const row: Room = { ...draft, date, verdict, id: createId('room'), createdAt: now, updatedAt: now };
    await db.rooms.put(row);
    // 越界即回写关联道次为待复检
    if (verdict !== 'suitable') {
      await useCoatStore.getState().markRecheck(row.bodyId, true);
    }
    await get().loadRooms();
    await useCoatStore.getState().syncDryingRecheck();
    return row;
  },

  async updateRoom(id, patch) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return;
    const tempC = patch.tempC ?? existing.tempC;
    const humidityPct = patch.humidityPct ?? existing.humidityPct;
    const verdict = judgeVerdict(tempC, humidityPct);
    await db.rooms.update(id, { ...patch, tempC, humidityPct, verdict, updatedAt: Date.now() } as never);
    if (verdict !== 'suitable') {
      await useCoatStore.getState().markRecheck(existing.bodyId, true);
    }
    await get().loadRooms();
    await useCoatStore.getState().syncDryingRecheck();
  },

  async removeRoom(id) {
    await db.rooms.delete(id);
    await get().loadRooms();
    await useCoatStore.getState().syncDryingRecheck();
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
