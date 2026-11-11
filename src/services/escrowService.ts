import { supabase, IS_DEMO_MODE } from '../lib/supabase';

export type EscrowStatus = 'draft' | 'awaiting_payment' | 'active' | 'work_submitted' | 'completed' | 'cancelled' | 'disputed';

export interface EscrowAction {
  label: string;
  action: () => Promise<void>;
  variant: 'primary' | 'secondary' | 'danger';
}

export const getEscrowActions = (
  contract: any, 
  userId: number, 
  refresh: () => void
): EscrowAction[] => {
  const actions: EscrowAction[] = [];
  const isBuyer = userId === contract.buyer_id;
  const isSeller = userId === contract.seller_id;

  const updateStatus = async (newStatus: EscrowStatus) => {
    if (IS_DEMO_MODE) {
      const saved = localStorage.getItem('mianji_mock_contracts');
      if (saved) {
        const contracts = JSON.parse(saved);
        const idx = contracts.findIndex((c: any) => c.contract_id === contract.contract_id);
        if (idx !== -1) {
          contracts[idx].status = newStatus;
          localStorage.setItem('mianji_mock_contracts', JSON.stringify(contracts));
          // Update selected contract too
          localStorage.setItem('selected_contract', JSON.stringify(contracts[idx]));
        }
      }
    } else {
      await supabase.from('contracts').update({ status: newStatus }).eq('contract_id', contract.contract_id);
    }
    refresh();
  };

  if (contract.status === 'draft') {
    if (isBuyer) {
      actions.push({
        label: 'تایید و درخواست پرداخت',
        variant: 'primary',
        action: async () => {
          await updateStatus('awaiting_payment');
        }
      });
    }
  }

  if (contract.status === 'awaiting_payment') {
    if (isBuyer) {
      actions.push({
        label: 'پرداخت امن وجه',
        variant: 'primary',
        action: async () => {
          await updateStatus('active');
          if (!IS_DEMO_MODE) {
            await supabase.from('transactions').insert({
              user_id: userId,
              contract_id: contract.contract_id,
              amount: contract.amount,
              type: 'escrow_lock',
              status: 'completed',
              description: `قفل وجه برای معامله ${contract.title}`
            });
          }
        }
      });
    }
  }

  if (contract.status === 'active') {
    if (isSeller) {
      actions.push({
        label: 'تحویل کار / ارسال فایل',
        variant: 'primary',
        action: async () => {
          await updateStatus('work_submitted');
        }
      });
    }
  }

  if (contract.status === 'work_submitted') {
    if (isBuyer) {
      actions.push({
        label: 'تایید نهایی و آزادسازی وجه',
        variant: 'primary',
        action: async () => {
          await updateStatus('completed');
          if (!IS_DEMO_MODE) {
            await supabase.from('transactions').insert({
              user_id: contract.seller_id,
              contract_id: contract.contract_id,
              amount: contract.amount,
              type: 'escrow_release',
              status: 'completed',
              description: `تسویه نهایی معامله ${contract.title}`
            });
          }
        }
      });
      actions.push({
        label: 'درخواست اصلاحات',
        variant: 'secondary',
        action: async () => {
          await updateStatus('active');
        }
      });
    }
  }

  if (!['completed', 'cancelled'].includes(contract.status)) {
    actions.push({
      label: 'گزارش اختلاف',
      variant: 'danger',
      action: async () => {
        await updateStatus('disputed');
      }
    });
  }

  return actions;
};
