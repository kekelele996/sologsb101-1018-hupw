/**
 * 按道次核对荫干时长（纯逻辑，无存储 / 无框架依赖）
 *
 * 规则：
 * - 每个髹涂道次的核对窗口 = 该道涂刷日（含）至下一道涂刷日（不含）；
 *   末道没有下一道时，窗口为涂刷日（含）起的开放区间。
 * - 把该件落在窗口内的每次荫房停留时长（inAt→outAt，跨夜自动加 24h）加总，
 *   与该道写明的建议荫干时长比较。
 * - 差值占建议时长 ≥ 四成（RECHECK_DIFF_RATIO）→ 待复检；有记录但不足四成 → 已对账；
 *   窗口内一条记录都没有 → 未对账（老档案照此保留，不算异常）。
 */
import type { Coat } from '@/types/coat';
import type { Room } from '@/types/room';
import { roomStayHours } from './humidity';

/** 差值达到建议时长的 40% 即标待复检 */
export const RECHECK_DIFF_RATIO = 0.4;

/** 按道次核对结果状态 */
export type DryingStatus = 'recheck' | 'matched' | 'unreconciled';

export const DRYING_STATUS_LABEL: Record<DryingStatus, string> = {
  recheck: '待复检',
  matched: '已对账',
  unreconciled: '未对账',
};

export interface DryingReconcileRow {
  coat: Coat;
  status: DryingStatus;
  /** 窗口内累计停留小时数（保留一位小数）；未对账时为 0 */
  actualHours: number;
  /** 建议荫干小时数 */
  suggestHours: number;
  /** 实际 - 建议（小时，正为荫干过久，负为不足） */
  diffHours: number;
  /** 差值占建议时长的比例（0-1+）；未对账时为 null */
  diffRatio: number | null;
  /** 计入本道窗口的荫房记录条数 */
  roomCount: number;
  /** 计入本道窗口的荫房记录（按日期升序） */
  rooms: Room[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 判断某次荫房记录是否落在道次窗口内：start ≤ date < end（end 缺省为开放） */
export function roomInWindow(roomDate: string, startDate: string, endDate: string | null): boolean {
  if (roomDate < startDate) return false;
  if (endDate !== null && roomDate >= endDate) return false;
  return true;
}

/**
 * 计算单道的核对结果。coats 应传入同胎体的全部道次（按 seq 升序）。
 */
export function reconcileCoatDrying(coat: Coat, bodyCoats: Coat[], bodyRooms: Room[]): DryingReconcileRow {
  const next = bodyCoats.find((item) => item.seq === coat.seq + 1);
  const endDate = next ? next.coatDate : null;
  const inWindow = bodyRooms
    .filter((room) => roomInWindow(room.date, coat.coatDate, endDate))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.inAt.localeCompare(b.inAt)));
  const actualHours = round1(inWindow.reduce((sum, room) => sum + roomStayHours(room.inAt, room.outAt), 0));
  const suggestHours = coat.suggestDryingHours;
  const roomCount = inWindow.length;

  if (roomCount === 0) {
    return {
      coat,
      status: 'unreconciled',
      actualHours: 0,
      suggestHours,
      diffHours: round1(0 - suggestHours),
      diffRatio: null,
      roomCount: 0,
      rooms: [],
    };
  }

  const diffHours = round1(actualHours - suggestHours);
  const diffRatio = suggestHours > 0 ? Math.abs(diffHours) / suggestHours : 0;
  return {
    coat,
    status: diffRatio >= RECHECK_DIFF_RATIO ? 'recheck' : 'matched',
    actualHours,
    suggestHours,
    diffHours,
    diffRatio,
    roomCount,
    rooms: inWindow,
  };
}

/** 状态排序权重：待复检在最前，其后已对账，未对账垫底 */
const STATUS_ORDER: Record<DryingStatus, number> = { recheck: 0, matched: 1, unreconciled: 2 };

/**
 * 跨全部胎体核对，并按「差得多的在最前」排序：
 * 先按状态（待复检 > 已对账 > 未对账），再按差值比例、差值小时数降序。
 */
export function reconcileAllDrying(coats: Coat[], rooms: Room[]): DryingReconcileRow[] {
  const coatsByBody = new Map<string, Coat[]>();
  const roomsByBody = new Map<string, Room[]>();
  coats.forEach((coat) => {
    const list = coatsByBody.get(coat.bodyId) ?? [];
    list.push(coat);
    coatsByBody.set(coat.bodyId, list);
  });
  rooms.forEach((room) => {
    const list = roomsByBody.get(room.bodyId) ?? [];
    list.push(room);
    roomsByBody.set(room.bodyId, list);
  });

  const rows: DryingReconcileRow[] = [];
  coatsByBody.forEach((bodyCoats, bodyId) => {
    const ordered = [...bodyCoats].sort((a, b) => a.seq - b.seq);
    const bodyRooms = roomsByBody.get(bodyId) ?? [];
    ordered.forEach((coat) => rows.push(reconcileCoatDrying(coat, ordered, bodyRooms)));
  });

  return rows.sort((a, b) => {
    if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) {
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    }
    const ar = a.diffRatio ?? -1;
    const br = b.diffRatio ?? -1;
    if (ar !== br) return br - ar;
    if (Math.abs(b.diffHours) !== Math.abs(a.diffHours)) return Math.abs(b.diffHours) - Math.abs(a.diffHours);
    if (a.coat.bodyId !== b.coat.bodyId) return a.coat.bodyId.localeCompare(b.coat.bodyId);
    return a.coat.seq - b.coat.seq;
  });
}
