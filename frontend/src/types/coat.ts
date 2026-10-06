/**
 * 髹涂道次（Coat）数据模型
 * 一件胎体上的逐道髹涂记录：漆种、色名、涂刷日期、湿膜厚度与状态推进。
 */

/** 漆种：生漆 / 色漆 / 罩漆 */
export type PaintType = 'raw' | 'color' | 'topcoat';

/** 道次状态：待涂 / 已涂 / 待打磨 / 已完成 */
export type CoatState = 'todo' | 'coated' | 'toPolish' | 'done';

/**
 * 按道次核对荫干时长后的对账状态：
 * - null（未对账）：该道窗口内还没有任何荫房记录（老档案照此保留，不算异常）
 * - false（已对账）：累计停留时长与建议时长相差不足四成
 * - true（待复检）：累计停留时长与建议时长相差达到四成及以上
 */
export type DryingRecheck = boolean | null;

export interface Coat {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 道次序号，从 1 开始连续整数 */
  seq: number;
  /** 漆种 */
  paintType: PaintType;
  /** 色名，如「朱红」「漆黑」 */
  colorName: string;
  /** 涂刷日期 yyyy-MM-dd */
  coatDate: string;
  /** 湿膜厚度（微米） */
  thicknessUm: number;
  /** 当前状态 */
  state: CoatState;
  /** 工序管理员写明的建议荫干时长（小时），按道次核对以此为基准 */
  suggestDryingHours: number;
  /** 按道次核对荫干停留时长后的对账状态，null 为未对账 */
  dryingRecheck: DryingRecheck;
  /** 荫房温湿度越界时回写的「待复检」标记 */
  needRecheck: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CoatDraft = Omit<Coat, 'id' | 'createdAt' | 'updatedAt'>;

export const PAINT_TYPE_LABEL: Record<PaintType, string> = {
  raw: '生漆',
  color: '色漆',
  topcoat: '罩漆',
};

export const COAT_STATE_LABEL: Record<CoatState, string> = {
  todo: '待涂',
  coated: '已涂',
  toPolish: '待打磨',
  done: '已完成',
};

export const COAT_STATE_COLOR: Record<CoatState, string> = {
  todo: '#8c8c8c',
  coated: '#c9963c',
  toPolish: '#8c2f1f',
  done: '#2f6f4f',
};

export const COAT_STATE_FLOW: readonly CoatState[] = ['todo', 'coated', 'toPolish', 'done'];

/** 各漆种默认建议荫干时长（小时），新建道次与 v3 迁移回填使用 */
export const DEFAULT_SUGGEST_DRYING_HOURS: Record<PaintType, number> = {
  raw: 24,
  color: 18,
  topcoat: 12,
};

export const PAINT_TYPE_OPTIONS: ReadonlyArray<{ value: PaintType; label: string }> = [
  { value: 'raw', label: '生漆' },
  { value: 'color', label: '色漆' },
  { value: 'topcoat', label: '罩漆' },
];

export const COAT_STATE_OPTIONS: ReadonlyArray<{ value: CoatState; label: string }> =
  COAT_STATE_FLOW.map((state) => ({ value: state, label: COAT_STATE_LABEL[state] }));

/** 色名候选，表单下拉直接复用 */
export const COLOR_NAME_OPTIONS: readonly string[] = [
  '漆黑',
  '朱红',
  '赭石',
  '藤黄',
  '石绿',
  '推光本色',
  '描金',
];

export function nextCoatState(state: CoatState): CoatState {
  const index = COAT_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= COAT_STATE_FLOW.length - 1) return state;
  return COAT_STATE_FLOW[index + 1] as CoatState;
}

/** 道次是否处于待复检：温湿度越界回写，或按道次核出荫干时长差出四成 */
export function coatAwaitingRecheck(coat: Coat): boolean {
  return coat.needRecheck === true || coat.dryingRecheck === true;
}

export function createEmptyCoatDraft(bodyId: string, seq: number, paintType: PaintType = 'raw'): CoatDraft {
  return {
    bodyId,
    seq,
    paintType,
    colorName: '漆黑',
    coatDate: new Date().toISOString().slice(0, 10),
    thicknessUm: 40,
    state: 'todo',
    suggestDryingHours: DEFAULT_SUGGEST_DRYING_HOURS[paintType],
    dryingRecheck: null,
    needRecheck: false,
  };
}
