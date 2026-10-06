/**
 * 荫干时长对账（按道次）
 * - 每个髹涂道次：把「涂完到下一道之间」的荫房停留时长逐趟累加，
 *   与该道在道次页登记的建议荫干时长（planDryHours）比对
 * - 偏差绝对值达到四成（40%）即标「待复检」，列表按偏差大的排在最前
 * - 值守补录漏记的进出房后重新对账，缺口补平自动摘标（见 coatStore.syncDryingRecheck）
 * - 老档案里还没有荫房记录的道次按「未对账」保留，不计入异常
 */
import type { Coat } from '@/types/coat';
import type { Room } from '@/types/room';
import { roomStayHours } from '@/utils/humidity';

/** 偏差阈值：实际停留与建议时长相差四成即标待复检 */
export const RECHECK_DEVIATION = 0.4;

/** 对账结论：待复检 / 正常 / 未对账 */
export type DryingReconStatus = 'recheck' | 'ok' | 'pending';

export const DRYING_RECON_LABEL: Record<DryingReconStatus, string> = {
  recheck: '待复检',
  ok: '正常',
  pending: '未对账',
};

export const DRYING_RECON_COLOR: Record<DryingReconStatus, string> = {
  recheck: '#b03a2e',
  ok: '#2f6f4f',
  pending: '#8c8479',
};

export interface DryingReconRow {
  coat: Coat;
  /** 本道登记的建议荫干时长（小时） */
  planHours: number;
  /** 涂完到下一道之间累计的荫房停留时长（小时） */
  actualHours: number;
  /** 窗口内荫房记录趟数 */
  roomCount: number;
  /** 偏差率 =（实际 - 建议）/ 建议；未对账时为 null */
  deviation: number | null;
  status: DryingReconStatus;
}

/**
 * 逐道对账：窗口为 [本道涂刷日期, 下一道涂刷日期)，最后一道到当前。
 * 返回行已按偏差绝对值降序排列，未对账（无偏差）排在最后。
 */
export function reconcileCoats(coats: Coat[], rooms: Room[]): DryingReconRow[] {
  const rows: DryingReconRow[] = [];
  const bodyIds = [...new Set(coats.map((coat) => coat.bodyId))];
  bodyIds.forEach((bodyId) => {
    const bodyCoats = coats
      .filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
    const bodyRooms = rooms.filter((room) => room.bodyId === bodyId);
    bodyCoats.forEach((coat, index) => {
      const next = bodyCoats[index + 1];
      const inWindow = bodyRooms.filter(
        (room) => room.date >= coat.coatDate && (next === undefined || room.date < next.coatDate),
      );
      const planHours = coat.planDryHours;
      if (inWindow.length === 0) {
        // 老档案缺荫房记录：按未对账保留，不算异常
        rows.push({ coat, planHours, actualHours: 0, roomCount: 0, deviation: null, status: 'pending' });
        return;
      }
      const actualHours =
        Math.round(inWindow.reduce((sum, room) => sum + roomStayHours(room.inAt, room.outAt), 0) * 10) / 10;
      const deviation = planHours > 0 ? (actualHours - planHours) / planHours : 0;
      rows.push({
        coat,
        planHours,
        actualHours,
        roomCount: inWindow.length,
        deviation: Math.round(deviation * 1000) / 1000,
        status: Math.abs(deviation) >= RECHECK_DEVIATION ? 'recheck' : 'ok',
      });
    });
  });
  // 差得多的排在最前；未对账没有偏差，排在列表最后
  return rows.sort((a, b) => {
    if (a.deviation === null && b.deviation === null) {
      return a.coat.bodyId.localeCompare(b.coat.bodyId) || a.coat.seq - b.coat.seq;
    }
    if (a.deviation === null) return 1;
    if (b.deviation === null) return -1;
    return Math.abs(b.deviation) - Math.abs(a.deviation);
  });
}
