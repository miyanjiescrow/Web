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
