/**
 * /rooms 荫房温湿度记录
 * 按区间判定适宜度并回写关联道次为「待复检」，支持日期区间与判定筛选（同步 URL query）。
 * 另按道次核对荫干时长：涂完到下一道之间的累计在房时长与建议值相比，差出四成列「待复检」，
 * 差值大的排在最前；窗口内没有记录的老档案列「未对账」，不算异常。
 * 同一天入房件数超过荫房容量时，新登记的后到件顺延第二天，既有记录不动。
 * 消费 Room、Coat；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoomStore } from '@/stores/roomStore';
import {
  ROOM_VERDICT_COLOR,
  ROOM_VERDICT_LABEL,
  ROOM_VERDICT_OPTIONS,
  createEmptyRoomDraft,
  type Room,
  type RoomDraft,
  type RoomVerdict,
} from '@/types/room';
import { PAINT_TYPE_LABEL } from '@/types/coat';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { dewPoint, dryingAdvice, dryingHours, judgeVerdict, rangeHint, roomStayHours } from '@/utils/humidity';
import { DRYING_STATUS_LABEL, reconcileAllDrying, type DryingReconcileRow, type DryingStatus } from '@/utils/dryingReconcile';

const FILTER_KEYS = ['verdict', 'dryingStatus'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'verdict', label: '判定', options: ROOM_VERDICT_OPTIONS },
  {
    key: 'dryingStatus',
    label: '对账',
    options: [
      { value: 'recheck', label: '待复检' },
      { value: 'matched', label: '已对账' },
      { value: 'unreconciled', label: '未对账' },
    ],
  },
];

const DRYING_STATUS_COLOR: Record<DryingStatus, string> = {
  recheck: '#b03a2e',
  matched: '#2f6f4f',
  unreconciled: '#8c8c8c',
};

export default function RoomLog() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<RoomDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const rooms = useRoomStore((state) => state.rooms);
  const createRoom = useRoomStore((state) => state.createRoom);
  const updateRoom = useRoomStore((state) => state.updateRoom);
  const removeRoom = useRoomStore((state) => state.removeRoom);
  const capacity = useRoomStore((state) => state.capacity);
  const setCapacity = useRoomStore((state) => state.setCapacity);
  const markRecheck = useCoatStore((state) => state.markRecheck);
  const syncDryingRecheck = useCoatStore((state) => state.syncDryingRecheck);
  const loadCoats = useCoatStore((state) => state.loadCoats);
  const coats = useCoatStore((state) => state.coats);

  const url = useFilterQuery(FILTER_KEYS);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [draftTemp, setDraftTemp] = useState(24);
  const [draftHumidity, setDraftHumidity] = useState(75);

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;
  const bodyShape = (bodyId: string): string => {
    const body = bodies.find((item) => item.id === bodyId);
    return body ? BODY_SHAPE_LABEL[body.shape] : '';
  };

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const verdicts = url.values.verdict ?? [];
    return rooms.filter((room) => {
      if (keyword.length > 0) {
        const haystack = `${bodyCode(room.bodyId)}${room.date}${room.tempC}${room.humidityPct}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (verdicts.length > 0 && !verdicts.includes(room.verdict)) return false;
      if (dateFrom.length > 0 && room.date < dateFrom) return false;
      if (dateTo.length > 0 && room.date > dateTo) return false;
      return true;
    });
  }, [rooms, url.keyword, url.values, dateFrom, dateTo, bodies]);

  const stat = useMemo(() => {
    const total = rooms.length;
    const suitable = rooms.filter((room) => room.verdict === 'suitable').length;
    const dry = rooms.filter((room) => room.verdict === 'dry').length;
    const wet = rooms.filter((room) => room.verdict === 'wet').length;
    const avgHumidity =
      total === 0 ? 0 : Math.round(rooms.reduce((sum, room) => sum + room.humidityPct, 0) / total);
    return {
      total,
      suitable,
      dry,
      wet,
      over: dry + wet,
      suitablePercent: total === 0 ? 0 : Math.round((suitable / total) * 100),
      avgHumidity,
    };
  }, [rooms]);

  /** 按道次核对结果（已按差值大小排序：待复检且差得多的在最前，未对账垫底） */
  const reconcileRows = useMemo(() => reconcileAllDrying(coats, rooms), [coats, rooms]);

  const reconcileStats = useMemo(() => {
    const recheck = reconcileRows.filter((row) => row.status === 'recheck').length;
    const matched = reconcileRows.filter((row) => row.status === 'matched').length;
    const unreconciled = reconcileRows.filter((row) => row.status === 'unreconciled').length;
    return { recheck, matched, unreconciled };
  }, [reconcileRows]);

  const filteredReconcile = useMemo(() => {
    const statuses = url.values.dryingStatus ?? [];
    if (statuses.length === 0) return reconcileRows;
    return reconcileRows.filter((row) => statuses.includes(row.status));
  }, [reconcileRows, url.values.dryingStatus]);

  const openCreate = (): void => {
    const bodyId = bodies[0]?.id ?? '';
    if (!bodyId) {
      message.warning('请先在胎体台账中登记胎体');
      return;
    }
    setEditing(null);
    const draft = createEmptyRoomDraft(bodyId);
    setDraftTemp(draft.tempC);
    setDraftHumidity(draft.humidityPct);
    form.setFieldsValue(draft);
    setOpen(true);
  };

  const openEdit = (room: Room): void => {
    setEditing(room);
    setDraftTemp(room.tempC);
    setDraftHumidity(room.humidityPct);
    form.setFieldsValue(room);
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const verdict = judgeVerdict(values.tempC, values.humidityPct);
    if (editing) {
      await updateRoom(editing.id, values);
      message.success(`已更新 ${values.date} 的荫房记录（判定：${ROOM_VERDICT_LABEL[verdict]}）`);
    } else {
      const result = await createRoom(values);
      if (result.shiftedDays > 0) {
        message.warning(
          `${values.date} 荫房已满（容量 ${capacity} 件/天），该件后到已顺延 ${result.shiftedDays} 天至 ${result.room.date} 入房`,
        );
      } else if (verdict === 'suitable') {
        message.success('已记录荫房温湿度，环境适宜');
      } else {
        message.warning(`判定为${ROOM_VERDICT_LABEL[verdict]}，已回写关联道次为待复检`);
      }
    }
    setOpen(false);
  };

  const runManualSync = async (): Promise<void> => {
    const changed = await syncDryingRecheck();
    await loadCoats();
    message.success(changed > 0 ? `已按道次重算，${changed} 道对账状态更新` : '已按道次重算，对账状态无变化');
  };

  const columns: ColumnsType<Room> = [
    { title: '日期', dataIndex: 'date', width: 120, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 120,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    { title: '温度', dataIndex: 'tempC', width: 90, render: (value: number) => `${value} ℃` },
    { title: '湿度', dataIndex: 'humidityPct', width: 90, render: (value: number) => `${value} %` },
    { title: '入房', dataIndex: 'inAt', width: 90 },
    { title: '出房', dataIndex: 'outAt', width: 90 },
    {
      title: '在房时长',
      key: 'stay',
      width: 110,
      render: (_value, record) => `${roomStayHours(record.inAt, record.outAt)} 小时`,
    },
    {
      title: '判定',
      dataIndex: 'verdict',
      width: 110,
      filters: ROOM_VERDICT_OPTIONS.map((item) => ({ text: item.label, value: item.value })),
      onFilter: (value, record) => record.verdict === value,
      render: (value: RoomVerdict, record) => (
        <Space size={4} wrap>
          <Tag color={ROOM_VERDICT_COLOR[value]}>{ROOM_VERDICT_LABEL[value]}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            露点 {dewPoint(record.tempC, record.humidityPct)}℃
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '荫干建议',
      key: 'advice',
      render: (_value, record) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {dryingAdvice(record.tempC, record.humidityPct, coats.find((coat) => coat.bodyId === record.bodyId)?.thicknessUm ?? 40)}
          （预计 {dryingHours(record.tempC, record.humidityPct, 40)} 小时）
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="link"
            icon={<ReloadOutlined />}
            onClick={() =>
              void markRecheck(record.bodyId, record.verdict !== 'suitable').then(() =>
                message.success(record.verdict === 'suitable' ? '已清除该胎体温湿度待复检标记' : '已回写待复检'),
              )
            }
          >
            回写道次
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该荫房记录"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removeRoom(record.id).then(() => message.success('已删除'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const reconcileColumns: ColumnsType<DryingReconcileRow> = [
    {
      title: '胎体',
      key: 'body',
      width: 130,
      render: (_v, row) => (
        <Tag color="#8c2f1f">
          {bodyCode(row.coat.bodyId)} · {bodyShape(row.coat.bodyId)}
        </Tag>
      ),
    },
    {
      title: '道次',
      key: 'seq',
      width: 150,
      render: (_v, row) => (
        <Space size={4}>
          <span>第 {row.coat.seq} 道</span>
          <Tag>{PAINT_TYPE_LABEL[row.coat.paintType]}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.coat.colorName}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '涂刷日期', dataIndex: ['coat', 'coatDate'], width: 110 },
    {
      title: '建议荫干',
      dataIndex: 'suggestHours',
      width: 100,
      sorter: (a, b) => a.suggestHours - b.suggestHours,
      render: (value: number) => `${value} h`,
    },
    {
      title: '累计在房',
      dataIndex: 'actualHours',
      width: 120,
      sorter: (a, b) => a.actualHours - b.actualHours,
      render: (value: number, row) => (
        <Tooltip title={row.rooms.map((room) => `${room.date} ${room.inAt}–${room.outAt}`).join('；') || '无记录'}>
          {value} h{row.roomCount > 0 ? `（${row.roomCount} 次进出）` : ''}
        </Tooltip>
      ),
    },
    {
      title: '差值',
      key: 'diff',
      width: 150,
      sorter: (a, b) => Math.abs(b.diffHours) - Math.abs(a.diffHours),
      render: (_v, row) =>
        row.diffRatio === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4}>
            <Typography.Text type={row.diffHours < 0 ? 'warning' : undefined}>
              {row.diffHours > 0 ? '+' : ''}
              {row.diffHours} h
            </Typography.Text>
            <Tag color={row.status === 'recheck' ? 'error' : 'default'}>{Math.round(row.diffRatio * 100)}%</Tag>
          </Space>
        ),
    },
    {
      title: '对账状态',
      key: 'status',
      width: 110,
      filters: [
        { text: '待复检', value: 'recheck' },
        { text: '已对账', value: 'matched' },
        { text: '未对账', value: 'unreconciled' },
      ],
      onFilter: (value, row) => row.status === value,
      render: (_v, row) => (
        <Tooltip
          title={
            row.status === 'unreconciled'
              ? '该道窗口内还没有荫房记录，老档案按未对账保留，不算异常；值守补记后自动核对'
              : row.status === 'recheck'
                ? '累计停留与建议时长相差四成及以上'
                : '累计停留与建议时长相差不足四成'
          }
        >
          <Tag color={DRYING_STATUS_COLOR[row.status]}>{DRYING_STATUS_LABEL[row.status]}</Tag>
        </Tooltip>
      ),
    },
  ];

  const previewVerdict = judgeVerdict(draftTemp, draftHumidity);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>荫房温湿度记录</h2>
          <p>{rangeHint()}；越界判定会回写关联道次为「待复检」，作为漆层缺陷回溯依据。</p>
        </div>
        <Space wrap>
          <Space size={4}>
            <Typography.Text type="secondary">荫房容量（件/天）</Typography.Text>
            <InputNumber
              min={1}
              max={99}
              size="small"
              style={{ width: 72 }}
              value={capacity}
              onChange={(value) => {
                if (typeof value === 'number' && value > 0) setCapacity(value);
              }}
            />
          </Space>
          <Button icon={<SyncOutlined />} onClick={() => void runManualSync()}>
            按道次重算
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增记录
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="记录总数" value={stat.total} suffix="条" tone="primary" />
        <StatBadge label="适宜占比" value={`${stat.suitablePercent}%`} percent={stat.suitablePercent} tone="success" />
        <StatBadge label="时长待复检" value={reconcileStats.recheck} suffix="道" tone="danger" />
        <StatBadge label="已对账" value={reconcileStats.matched} suffix="道" tone="success" />
        <StatBadge label="未对账" value={reconcileStats.unreconciled} suffix="道" tone="warning" />
        <StatBadge label="平均湿度" value={stat.avgHumidity} suffix="%" />
      </div>

      <Card
        className="gb-table-card"
        style={{ marginBottom: 16 }}
        styles={{ body: { padding: 0 } }}
        title={
          <Space size={8}>
            <span>按道次核对荫干时长</span>
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
              涂完到下一道之间的在房时长累计核对，差四成标待复检，差得多的排最前；补记进出房后自动摘除
            </Typography.Text>
          </Space>
        }
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            荫房容量 {capacity} 件/天，满房后到的件顺延第二天（既有记录不动）
          </Typography.Text>
        }
      >
        {reconcileRows.length === 0 ? (
          <EmptyPanel
            title="还没有髹涂道次可供核对"
            description="先在髹涂道次页编排道次并写明建议荫干时长，值守登记进出房后这里会自动按道次核对。"
            size="small"
          />
        ) : (
          <Table<DryingReconcileRow>
            rowKey={(row) => row.coat.id}
            size="small"
            pagination={{ pageSize: 5 }}
            columns={reconcileColumns}
            dataSource={filteredReconcile}
          />
        )}
      </Card>

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={() => {
          url.reset();
          setDateFrom('');
          setDateTo('');
        }}
        keywordPlaceholder="搜索编号 / 日期 / 温湿度…"
        actions={
          <Space size={6} wrap>
            <Input
              type="date"
              size="small"
              style={{ width: 150 }}
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
            <Typography.Text type="secondary">至</Typography.Text>
            <Input
              type="date"
              size="small"
              style={{ width: 150 }}
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={rooms.length === 0 ? '还没有荫房记录' : '当前条件下没有记录'}
            description={
              rooms.length === 0
                ? '每次入荫房时登记温度、湿度与出入房时间；当天满房时后到的件自动顺延第二天。'
                : '试着调整判定或日期区间。'
            }
            actionText="新增记录"
            onAction={openCreate}
            secondaryText="重置筛选"
            onSecondary={() => {
              url.reset();
              setDateFrom('');
              setDateTo('');
            }}
            size="small"
          />
        ) : (
          <Table<Room> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={columns} dataSource={filtered} />
        )}
      </Card>

      <Modal
        open={open}
        title={editing ? `编辑 ${editing.date} 的荫房记录` : '新增荫房记录'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false} onValuesChange={(changed) => {
          if (typeof changed.tempC === 'number') setDraftTemp(changed.tempC);
          if (typeof changed.humidityPct === 'number') setDraftHumidity(changed.humidityPct);
        }}>
          <Form.Item name="bodyId" label="关联胎体" rules={[{ required: true, message: '请选择胎体' }]}>
            <Select
              options={bodies.map((body) => ({
                value: body.id,
                label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
              }))}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="登记入房日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="inAt" label="入房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
            <Form.Item name="outAt" label="出房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="tempC" label="温度（℃）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={5} max={45} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="humidityPct" label="湿度（%）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space direction="vertical" size={2}>
            <Tag color={ROOM_VERDICT_COLOR[previewVerdict]}>实时判定：{ROOM_VERDICT_LABEL[previewVerdict]}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              露点约 {dewPoint(draftTemp, draftHumidity)}℃ · 在房 {roomStayHours(form.getFieldValue('inAt') ?? '09:00', form.getFieldValue('outAt') ?? '21:00')} 小时
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {dryingAdvice(draftTemp, draftHumidity, 40)}
            </Typography.Text>
            {!editing ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                保存时若当天入房件数超过 {capacity} 件容量，后到的这件会自动顺延到第二天，已记下的记录不改动。
              </Typography.Text>
            ) : null}
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
