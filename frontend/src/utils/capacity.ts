/**
 * 荫房容量调度（纯逻辑）
 *
 * 同一天要进房的不同件数超过荫房放得下的件数时，后到的登记顺延到第二天。
 * 注意：只决定「新登记的这一条」落在哪一天，值守已经记下的记录一律不动；
 * 容量按同一天不同胎体件数计（一件一天多次进出仍只占一个坑位）。
 */
import type { Room } from '@/types/room';
import { LS_KEYS } from './db';

/** 荫房默认容量（件 / 天），可在荫房记录页调整并保存在 localStorage */
export const DEFAULT_ROOM_CAPACITY = 6;

/** 读取荫房容量设置（非法或缺省回落到默认值） */
export function readRoomCapacity(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.roomCapacity);
    const value = raw === null ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_ROOM_CAPACITY;
  } catch {
    return DEFAULT_ROOM_CAPACITY;
  }
}

/** 保存荫房容量设置 */
export function writeRoomCapacity(capacity: number): void {
  try {
    localStorage.setItem(LS_KEYS.roomCapacity, String(capacity));
  } catch {
    /* 忽略隐私模式写入失败 */
  }
}

/** 顺延查找天数上限，避免异常数据下死循环 */
const MAX_SHIFT_DAYS = 366;

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map((item) => Number.parseInt(item, 10));
  const next = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  next.setUTCDate(next.getUTCDate() + days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** 当天已占坑位的不同件数；excludeRoomId 用于编辑场景排除自身 */
export function occupiedBodyCount(rooms: Room[], date: string, excludeRoomId?: string): number {
  const ids = new Set<string>();
  rooms.forEach((room) => {
    if (room.date === date && room.id !== excludeRoomId) ids.add(room.bodyId);
  });
  return ids.size;
}

export interface ScheduleRoomDateResult {
  /** 最终排定的日期（容量满则顺延到下一天） */
  date: string;
  /** 相对登记日期顺延了几天（0 表示当天就能进房） */
  shiftedDays: number;
}

/**
 * 给定想登记的入房日期与所属胎体，返回实际可排日期。
 * 同件当天已有记录视为仍占用同一坑位（不再额外占位，也不会把自己挤到第二天）。
 */
export function scheduleRoomDate(
  rooms: Room[],
  preferredDate: string,
  bodyId: string,
  capacity: number,
  excludeRoomId?: string,
): ScheduleRoomDateResult {
  const cap = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : DEFAULT_ROOM_CAPACITY;
  let date = preferredDate;
  for (let shift = 0; shift < MAX_SHIFT_DAYS; shift += 1) {
    const occupied = occupiedBodyCount(rooms, date, excludeRoomId);
    const sameBodyAlreadyIn = rooms.some(
      (room) => room.date === date && room.bodyId === bodyId && room.id !== excludeRoomId,
    );
    if (sameBodyAlreadyIn || occupied < cap) return { date, shiftedDays: shift };
    date = addDays(date, 1);
  }
  return { date: addDays(preferredDate, MAX_SHIFT_DAYS), shiftedDays: MAX_SHIFT_DAYS };
}
