import { apiFetch } from '../lib/apiClient';

export type EscrowStatus =
  | 'draft'
  | 'awaiting_payment'
  | 'active'
  | 'work_submitted'
  | 'completed'
  | 'cancelled'
  | 'disputed';

export interface EscrowAction {
  label: string;
  action: () => Promise<void>;
  variant: 'primary' | 'secondary' | 'danger';
}

export interface EscrowTransitionPayload {
  note?: string;
  attachment_url?: string;
}

export const transitionEscrowContract = async (
  contract: any,
  newStatus: EscrowStatus,
  refresh: (updatedContract?: any, balances?: Record<string, { wallet_balance: number; escrow_locked_balance: number }>) => void | Promise<void>,
  isDemo: boolean = false,
  payload?: EscrowTransitionPayload
) => {
  const isExplicitDemo = isDemo && localStorage.getItem('mianji_demo_mode') === 'true';
  if (isExplicitDemo) {
    const saved = localStorage.getItem('mianji_mock_contracts');
    const contracts = saved ? JSON.parse(saved) : [];
    const idx = contracts.findIndex((c: any) => c.contract_id === contract.contract_id);
    const nowIso = new Date().toISOString();
    const timelineEntry = {
      id: `tl_${Date.now()}`,
      type: 'status_change',
      status: newStatus,
      note: payload?.note,
      attachment_url: payload?.attachment_url,
      timestamp: nowIso,
    };
    const nextFields: any = {
      status: newStatus,
      updated_at: nowIso,
      timeline: [...(Array.isArray(contract.timeline) ? contract.timeline : []), timelineEntry],
    };
    if (newStatus === 'work_submitted') {
      if (payload?.note) nextFields.delivery_note = payload.note;
      if (payload?.attachment_url) nextFields.delivery_attachment_url = payload.attachment_url;
    } else if (newStatus === 'active' && contract.status === 'work_submitted' && payload?.note) {
      nextFields.revision_note = payload.note;
    }
    let updated: any;
    if (idx !== -1) {
      contracts[idx] = { ...contracts[idx], ...nextFields };
      updated = contracts[idx];
    } else {
      updated = { ...contract, ...nextFields };
      contracts.unshift(updated);
    }
    localStorage.setItem('mianji_mock_contracts', JSON.stringify(contracts));
    localStorage.setItem('selected_contract', JSON.stringify(updated));
    await refresh(updated);
    return updated;
  }

  const cid = String(contract.contract_id || contract.id);
  const res = await apiFetch<{
    success: boolean;
    deal: any;
    balances?: Record<string, { wallet_balance: number; escrow_locked_balance: number }>;
  }>(`/api/deals/${encodeURIComponent(cid)}/transition`, {
    method: 'POST',
    body: JSON.stringify({
      status: newStatus,
      ...(payload?.note ? { note: payload.note } : {}),
      ...(payload?.attachment_url ? { attachment_url: payload.attachment_url } : {}),
    }),
  });

  if (res.deal) {
    localStorage.setItem('selected_contract', JSON.stringify(res.deal));
  }
  await refresh(res.deal, res.balances);
  return res.deal;
};

export const getEscrowActions = (
  contract: any,
  userId: string | number,
  refresh: (updatedContract?: any, balances?: Record<string, { wallet_balance: number; escrow_locked_balance: number }>) => void | Promise<void>,
  isDemo: boolean = false
): EscrowAction[] => {
  const actions: EscrowAction[] = [];
  const uid = String(userId ?? '');
  const isBuyer = uid !== '' && uid === String(contract?.buyer_id ?? '');
  const isSeller = uid !== '' && uid === String(contract?.seller_id ?? '');

  const updateStatus = async (newStatus: EscrowStatus, payload?: EscrowTransitionPayload) => {
    await transitionEscrowContract(contract, newStatus, refresh, isDemo, payload);
  };

  if (contract.status === 'draft' && isBuyer) {
    actions.push({
      label: 'تایید و درخواست پرداخت',
      variant: 'primary',
      action: () => updateStatus('awaiting_payment'),
    });
  }

  if (contract.status === 'awaiting_payment' && isBuyer) {
    actions.push({
      label: 'پرداخت امن وجه',
      variant: 'primary',
      action: () => updateStatus('active'),
    });
  }

  const isMilestoneContract = Boolean(
    contract?.is_milestone && Array.isArray(contract?.milestones) && contract.milestones.length >= 2
  );

  if (contract.status === 'active' && isSeller && !isMilestoneContract) {
    actions.push({
      label: 'تحویل کار / ارسال فایل',
      variant: 'primary',
      action: () => updateStatus('work_submitted'),
    });
  }

  if (contract.status === 'work_submitted' && isBuyer) {
    actions.push({
      label: 'تایید نهایی و آزادسازی وجه',
      variant: 'primary',
      action: () => updateStatus('completed'),
    });
    actions.push({
      label: 'درخواست اصلاحات',
      variant: 'secondary',
      action: () => updateStatus('active'),
    });
  }

  if (['draft', 'awaiting_payment'].includes(contract.status) && (isBuyer || isSeller)) {
    actions.push({
      label: 'لغو معامله',
      variant: 'secondary',
      action: () => updateStatus('cancelled'),
    });
  }

  if (!['completed', 'cancelled', 'disputed'].includes(contract.status) && (isBuyer || isSeller)) {
    actions.push({
      label: 'گزارش اختلاف',
      variant: 'danger',
      action: () => updateStatus('disputed'),
    });
  }

  return actions;
};

export const transitionMilestone = async (
  contract: any,
  milestoneId: string,
  action: 'submit' | 'revision' | 'release',
  refresh: (updatedContract?: any, balances?: Record<string, { wallet_balance: number; escrow_locked_balance: number }>) => void | Promise<void>,
  payload?: EscrowTransitionPayload
) => {
  const cid = String(contract.contract_id || contract.id);
  const res = await apiFetch<{
    success: boolean;
    deal: any;
    balances?: Record<string, { wallet_balance: number; escrow_locked_balance: number }>;
  }>(`/api/deals/${encodeURIComponent(cid)}/milestones/${encodeURIComponent(milestoneId)}/transition`, {
    method: 'POST',
    body: JSON.stringify({
      action,
      ...(payload?.note ? { note: payload.note } : {}),
      ...(payload?.attachment_url ? { attachment_url: payload.attachment_url } : {}),
    }),
  });

  if (res.deal) {
    localStorage.setItem('selected_contract', JSON.stringify(res.deal));
  }
  await refresh(res.deal, res.balances);
  return res.deal;
};

export const submitDealReview = async (
  contractId: string,
  score: number,
  comment: string,
  refresh: (updatedContract?: any) => void | Promise<void>
) => {
  const res = await apiFetch<{
    success: boolean;
    review: any;
    deal: any;
    rating?: { rating_avg: number; rating_count: number };
  }>(`/api/deals/${encodeURIComponent(contractId)}/review`, {
    method: 'POST',
    body: JSON.stringify({ score, comment }),
  });

  if (res.deal) {
    localStorage.setItem('selected_contract', JSON.stringify(res.deal));
  }
  await refresh(res.deal);
  return res;
};

export const isPendingPartyId = (id: any): boolean => {
  const s = String(id || '').trim();
  return s.startsWith('pending_') || s === 'pending';
};

export const buildDealInviteUrl = (contractId: string, inviteToken?: string): string => {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const params = new URLSearchParams();
  params.set('sign_deal', contractId);
  if (inviteToken) params.set('token', inviteToken);
  return `${origin}/?${params.toString()}`;
};

export const extractDealInviteFromQr = (rawText: string): { contractId: string; token?: string } | null => {
  const cleaned = String(rawText || '').trim();
  if (!cleaned) return null;

  if (cleaned.includes('sign_deal=')) {
    try {
      const parsedUrl = new URL(cleaned.startsWith('http') ? cleaned : `https://mianji.local/${cleaned.replace(/^\/+/, '')}`);
      const contractId = String(parsedUrl.searchParams.get('sign_deal') || '').trim();
      const token = String(parsedUrl.searchParams.get('token') || '').trim() || undefined;
      if (contractId) return { contractId, token };
    } catch {}
  }

  const mMatch = cleaned.match(/M-\d{5,8}/i);
  if (mMatch) {
    return { contractId: mMatch[0].toUpperCase() };
  }

  return null;
};

export interface DealInvitePreview {
  contract_id: string;
  title: string;
  amount: number;
  fee_percent?: number;
  fee_amount?: number;
  net_seller_amount?: number;
  is_milestone?: boolean;
  milestones?: any[];
  category?: string;
  description?: string;
  deadline?: string;
  revisions?: string;
  inspection_hours?: string | number;
  status: string;
  invite_mode: boolean;
  missing_role: 'buyer' | 'seller' | null;
  creator_id: string;
  creator_name?: string;
  buyer_id: string;
  seller_id: string;
  buyer_name?: string;
  seller_name?: string;
  already_claimed: boolean;
  is_caller_creator: boolean;
  can_claim_and_sign: boolean;
}

export const fetchDealInvitePreview = async (
  contractId: string,
  token?: string
): Promise<DealInvitePreview> => {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  const endpoint = `/api/deals/invite/${encodeURIComponent(contractId)}${qs}`;
  const hasToken = Boolean(localStorage.getItem('mianji_session_token'));

  if (hasToken) {
    const res = await apiFetch<{ success: boolean; invite: DealInvitePreview; error?: string }>(endpoint);
    if (!res.success || !res.invite) {
      throw new Error(res.error || 'اطلاعات دعوت قرارداد یافت نشد');
    }
    return res.invite;
  }

  const rawRes = await fetch(endpoint);
  const data = await rawRes.json().catch(() => ({}));
  if (!rawRes.ok || !data?.success || !data?.invite) {
    throw new Error(data?.error || 'اطلاعات دعوت قرارداد یافت نشد یا لینک نامعتبر است');
  }
  return data.invite;
};

export const claimAndSignDeal = async (
  contractId: string,
  token: string | undefined,
  action: 'join_and_sign' | 'join_only' = 'join_and_sign',
  refresh?: (updatedContract?: any) => void | Promise<void>
) => {
  const res = await apiFetch<{ success: boolean; deal: any; error?: string }>(
    `/api/deals/${encodeURIComponent(contractId)}/claim-and-sign`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(token ? { token } : {}),
        action,
      }),
    }
  );
  if (res.deal) {
    localStorage.setItem('selected_contract', JSON.stringify(res.deal));
  }
  if (refresh) {
    await refresh(res.deal);
  }
  return res.deal;
};

export interface DealDraftRecord {
  id: string;
  owner_id?: string;
  title: string;
  amount: string;
  role: 'buyer' | 'seller';
  phone: string;
  category: 'digital' | 'physical' | 'account' | 'other';
  deadline: string;
  revisions: string;
  inspection_hours: string;
  description: string;
  is_milestone?: boolean;
  milestones?: Array<{ title: string; amount: string }>;
  step?: number;
  updated_at: string;
}

const LOCAL_DRAFTS_KEY = 'mianji_deal_drafts';

export const readLocalDealDrafts = (): DealDraftRecord[] => {
  try {
    const raw = localStorage.getItem(LOCAL_DRAFTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const writeLocalDealDrafts = (drafts: DealDraftRecord[]) => {
  try {
    localStorage.setItem(LOCAL_DRAFTS_KEY, JSON.stringify(drafts.slice(0, 25)));
  } catch {}
};

export const fetchDealDrafts = async (): Promise<DealDraftRecord[]> => {
  try {
    const res = await apiFetch<{ success: boolean; drafts: DealDraftRecord[] }>('/api/deal-drafts');
    if (res.success && Array.isArray(res.drafts)) {
      writeLocalDealDrafts(res.drafts);
      return res.drafts;
    }
  } catch {}
  return readLocalDealDrafts();
};

export const saveDealDraft = async (draft: DealDraftRecord): Promise<DealDraftRecord> => {
  const local = readLocalDealDrafts();
  const nextLocal = [draft, ...local.filter((d) => String(d.id) !== String(draft.id))].slice(0, 25);
  writeLocalDealDrafts(nextLocal);

  try {
    const res = await apiFetch<{ success: boolean; draft: DealDraftRecord }>(
      `/api/deal-drafts/${encodeURIComponent(draft.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(draft),
      }
    );
    if (res.success && res.draft) {
      return res.draft;
    }
  } catch {}
  return draft;
};

export const deleteDealDraft = async (draftId: string): Promise<void> => {
  const local = readLocalDealDrafts();
  writeLocalDealDrafts(local.filter((d) => String(d.id) !== String(draftId)));
  try {
    await apiFetch(`/api/deal-drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
  } catch {}
};

