import { apiFetch } from '../lib/apiClient';
import {
  isPendingPartyId as isPendingPartyIdSync,
  isUserDealBuyer,
  isUserDealCreator,
  isUserDealSeller,
  normalizeDealStatus,
  normalizeDigits,
  CommissionPayer,
} from '../lib/dealSync';

export type EscrowStatus =
  | 'draft'
  | 'pending_party_b'
  | 'awaiting_payment'
  | 'awaiting_receipt_approval'
  | 'active'
  | 'work_submitted'
  | 'revisions_requested'
  | 'completed'
  | 'cancelled'
  | 'in_dispute';

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
  _isDemo: boolean = false,
  payload?: EscrowTransitionPayload
) => {
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
  userOrId: any,
  refresh: (updatedContract?: any, balances?: Record<string, { wallet_balance: number; escrow_locked_balance: number }>) => void | Promise<void>,
  isDemo: boolean = false
): EscrowAction[] => {
  const actions: EscrowAction[] = [];
  const isBuyer = isUserDealBuyer(contract, userOrId);
  const isSeller = isUserDealSeller(contract, userOrId);
  const buyerPending = isPendingPartyIdSync(contract?.buyer_id);
  const sellerPending = isPendingPartyIdSync(contract?.seller_id);
  const hasBothParties = !buyerPending && !sellerPending;
  const canonical = normalizeDealStatus(contract?.status);

  const updateStatus = async (newStatus: EscrowStatus, payload?: EscrowTransitionPayload) => {
    await transitionEscrowContract(contract, newStatus, refresh, isDemo, payload);
  };

  if (canonical === 'draft' && (isBuyer || isSeller)) {
    if (!hasBothParties || !contract?.buyer_signed_at || !contract?.seller_signed_at) {
      actions.push({
        label: 'ارسال برای تایید و امضای طرف دوم',
        variant: 'primary',
        action: () => updateStatus('pending_party_b'),
      });
    }
    if (isBuyer && hasBothParties) {
      actions.push({
        label: 'تایید و درخواست پرداخت',
        variant: hasBothParties && contract?.seller_signed_at ? 'primary' : 'secondary',
        action: () => updateStatus('awaiting_payment'),
      });
    }
  }

  if (canonical === 'pending_party_b' && hasBothParties && (isBuyer || isSeller)) {
    const isCreator = isUserDealCreator(contract, userOrId);
    if (!isCreator) {
      actions.push({
        label: 'تایید و امضای قرارداد',
        variant: 'primary',
        action: () => updateStatus('awaiting_payment'),
      });
    }
  }

  if (canonical === 'awaiting_payment' && isBuyer) {
    actions.push({
      label: 'پرداخت امن و قفل وجه',
      variant: 'primary',
      action: () => updateStatus('active'),
    });
  }

  const isMilestoneContract = Boolean(
    (contract?.staged_payment ?? contract?.is_milestone) &&
      Array.isArray(contract?.milestones) &&
      contract.milestones.length >= 2
  );

  if ((canonical === 'active' || canonical === 'revisions_requested') && isSeller && !isMilestoneContract) {
    actions.push({
      label: canonical === 'revisions_requested' ? 'ارسال مجدد تحویل کار' : 'تحویل کار / ارسال فایل',
      variant: 'primary',
      action: () => updateStatus('work_submitted'),
    });
  }

  if (canonical === 'work_submitted' && isBuyer) {
    actions.push({
      label: 'تایید نهایی و آزادسازی وجه',
      variant: 'primary',
      action: () => updateStatus('completed'),
    });
    const freeLeft = Number(contract?.free_edits_left ?? contract?.free_edits ?? contract?.revisions ?? 0);
    if (freeLeft > 0 || contract?.free_edits_left === undefined) {
      actions.push({
        label: 'درخواست اصلاحات',
        variant: 'secondary',
        action: () => updateStatus('revisions_requested'),
      });
    }
  }

  if (['draft', 'pending_party_b', 'awaiting_payment'].includes(canonical) && (isBuyer || isSeller)) {
    actions.push({
      label: 'لغو معامله',
      variant: 'secondary',
      action: () => updateStatus('cancelled'),
    });
  }

  if (!['completed', 'cancelled', 'in_dispute'].includes(canonical) && (isBuyer || isSeller)) {
    actions.push({
      label: 'گزارش اختلاف',
      variant: 'danger',
      action: () => updateStatus('in_dispute'),
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

export const isPendingPartyId = isPendingPartyIdSync;

export const buildDealInviteUrl = (contractId: string, inviteToken?: string): string => {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const params = new URLSearchParams();
  params.set('sign_deal', contractId);
  if (inviteToken) params.set('token', inviteToken);
  return `${origin}/?${params.toString()}`;
};

export const extractDealInviteFromQr = (rawText: string): { contractId: string; token?: string } | null => {
  const cleaned = normalizeDigits(String(rawText || '').trim());
  if (!cleaned) return null;

  if (cleaned.includes('sign_deal=') || cleaned.includes('contract_id=')) {
    try {
      const parsedUrl = new URL(cleaned.startsWith('http') ? cleaned : `https://mianji.local/${cleaned.replace(/^\/+/, '')}`);
      const contractId = String(
        parsedUrl.searchParams.get('sign_deal') || parsedUrl.searchParams.get('contract_id') || ''
      ).trim().toUpperCase();
      const token = String(parsedUrl.searchParams.get('token') || '').trim() || undefined;
      if (contractId) return { contractId, token };
    } catch {}
  }

  if (cleaned.includes('start=c_') || /^c_/i.test(cleaned)) {
    try {
      if (/^c_/i.test(cleaned)) {
        const cid = cleaned.slice(2).trim().toUpperCase();
        if (cid) return { contractId: cid, token: `c_${cid}` };
      }
      const parsedUrl = new URL(cleaned.startsWith('http') ? cleaned : `https://t.me/${cleaned.replace(/^\/+/, '')}`);
      const startParam = String(parsedUrl.searchParams.get('start') || '').trim();
      if (/^c_/i.test(startParam) && startParam.length > 2) {
        const cid = startParam.slice(2).toUpperCase();
        return { contractId: cid, token: `c_${cid}` };
      }
    } catch {}
  }

  const botMatch = cleaned.match(/[A-Z]{2,5}-[A-Z0-9]{2,8}-[A-Z0-9]{2,8}/i);
  if (botMatch) {
    return { contractId: botMatch[0].toUpperCase() };
  }

  const mMatch = cleaned.match(/M-\d{4,10}/i);
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
  employer_fee?: number;
  freelancer_fee?: number;
  employer_total_payable?: number;
  net_seller_amount?: number;
  commission_payer?: CommissionPayer | string;
  staged_payment?: boolean;
  is_milestone?: boolean;
  milestones?: any[];
  category?: string;
  description?: string;
  deadline?: string | number;
  free_edits?: number;
  revisions?: string | number;
  inspection_hours?: string | number;
  status: string;
  invite_mode: boolean;
  invite_token?: string;
  bot_invite_url?: string;
  missing_role: 'buyer' | 'seller' | null;
  creator_id: string;
  creator_name?: string;
  buyer_id: string | null;
  seller_id: string | null;
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
  category: string;
  deadline: string;
  free_edits?: number;
  revisions: string;
  inspection_hours: string;
  commission_payer?: CommissionPayer;
  description: string;
  staged_payment?: boolean;
  is_milestone?: boolean;
  milestone_template?: string;
  milestones?: Array<{ title: string; amount: string; percentage?: number; deadline_days?: number }>;
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

