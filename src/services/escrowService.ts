import { supabase } from '../lib/supabase';

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

  if (contract.status === 'draft') {
    if (isBuyer) {
      actions.push({
        label: 'تایید و درخواست پرداخت',
        variant: 'primary',
        action: async () => {
          await supabase.from('contracts').update({ status: 'awaiting_payment' }).eq('contract_id', contract.contract_id);
          refresh();
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
          // In a real app, this would redirect to a gateway
          await supabase.from('contracts').update({ status: 'active' }).eq('contract_id', contract.contract_id);
          // Log transaction
          await supabase.from('transactions').insert({
            user_id: userId,
            contract_id: contract.contract_id,
            amount: contract.amount,
            type: 'escrow_lock',
            status: 'completed',
            description: `قفل وجه برای معامله ${contract.title}`
          });
          refresh();
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
          await supabase.from('contracts').update({ status: 'work_submitted' }).eq('contract_id', contract.contract_id);
          refresh();
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
          await supabase.from('contracts').update({ status: 'completed' }).eq('contract_id', contract.contract_id);
          // Release funds transaction
          await supabase.from('transactions').insert({
            user_id: contract.seller_id,
            contract_id: contract.contract_id,
            amount: contract.amount,
            type: 'escrow_release',
            status: 'completed',
            description: `تسویه نهایی معامله ${contract.title}`
          });
          refresh();
        }
      });
      actions.push({
        label: 'درخواست اصلاحات',
        variant: 'secondary',
        action: async () => {
          await supabase.from('contracts').update({ status: 'active' }).eq('contract_id', contract.contract_id);
          refresh();
        }
      });
    }
  }

  if (!['completed', 'cancelled'].includes(contract.status)) {
    actions.push({
      label: 'گزارش اختلاف',
      variant: 'danger',
      action: async () => {
        await supabase.from('contracts').update({ status: 'disputed' }).eq('contract_id', contract.contract_id);
        refresh();
      }
    });
  }

  return actions;
};
