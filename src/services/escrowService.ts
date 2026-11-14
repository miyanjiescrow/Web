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
  const isExplicitDemo = isDemo && localStorage.getItem('mianji_demo_mode') === 'true';

  const updateStatus = async (newStatus: EscrowStatus) => {
    if (isExplicitDemo) {
      const saved = localStorage.getItem('mianji_mock_contracts');
      const contracts = saved ? JSON.parse(saved) : [];
      const idx = contracts.findIndex((c: any) => c.contract_id === contract.contract_id);
      let updated: any;
      if (idx !== -1) {
        contracts[idx].status = newStatus;
        contracts[idx].updated_at = new Date().toISOString();
        updated = contracts[idx];
      } else {
        updated = { ...contract, status: newStatus, updated_at: new Date().toISOString() };
        contracts.unshift(updated);
      }
      localStorage.setItem('mianji_mock_contracts', JSON.stringify(contracts));
      localStorage.setItem('selected_contract', JSON.stringify(updated));
      await refresh(updated);
      return;
    }

    const cid = String(contract.contract_id || contract.id);
    const res = await apiFetch<{
      success: boolean;
      deal: any;
      balances?: Record<string, { wallet_balance: number; escrow_locked_balance: number }>;
    }>(`/api/deals/${encodeURIComponent(cid)}/transition`, {
      method: 'POST',
      body: JSON.stringify({ status: newStatus }),
    });

    if (res.deal) {
      localStorage.setItem('selected_contract', JSON.stringify(res.deal));
    }
    await refresh(res.deal, res.balances);
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

  if (contract.status === 'active' && isSeller) {
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
