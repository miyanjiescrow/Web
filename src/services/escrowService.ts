import { auth, db } from '../lib/firebase';
import { doc, updateDoc, addDoc, collection, serverTimestamp } from 'firebase/firestore';

export type EscrowStatus = 'draft' | 'awaiting_payment' | 'active' | 'work_submitted' | 'completed' | 'cancelled' | 'disputed';

export interface EscrowAction {
  label: string;
  action: () => Promise<void>;
  variant: 'primary' | 'secondary' | 'danger';
}

export const getEscrowActions = (
  contract: any,
  userId: string | number,
  refresh: () => void | Promise<void>,
  isDemo: boolean = false
): EscrowAction[] => {
  const actions: EscrowAction[] = [];
  const uid = String(userId ?? '');
  const isBuyer = uid !== '' && uid === String(contract?.buyer_id ?? '');
  const isSeller = uid !== '' && uid === String(contract?.seller_id ?? '');
  const useLocalFallback = isDemo || !auth.currentUser;

  const updateStatus = async (newStatus: EscrowStatus) => {
    if (useLocalFallback) {
      const saved = localStorage.getItem('mianji_mock_contracts');
      const contracts = saved ? JSON.parse(saved) : [];
      const idx = contracts.findIndex((c: any) => c.contract_id === contract.contract_id);
      if (idx !== -1) {
        contracts[idx].status = newStatus;
        contracts[idx].updated_at = new Date().toISOString();
        localStorage.setItem('mianji_mock_contracts', JSON.stringify(contracts));
        localStorage.setItem('selected_contract', JSON.stringify(contracts[idx]));
      } else {
        const updated = { ...contract, status: newStatus, updated_at: new Date().toISOString() };
        localStorage.setItem('mianji_mock_contracts', JSON.stringify([updated, ...contracts]));
        localStorage.setItem('selected_contract', JSON.stringify(updated));
      }
    } else {
      const dealDocId = String(contract.id || contract.contract_id);
      const contractRef = doc(db, 'deals', dealDocId);
      await updateDoc(contractRef, {
        status: newStatus,
        updatedAt: serverTimestamp()
      });
    }
    await refresh();
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
          if (!useLocalFallback) {
            await addDoc(collection(db, 'transactions'), {
              user_id: String(userId),
              contract_id: String(contract.contract_id),
              amount: Number(contract.amount),
              type: 'escrow_lock',
              status: 'completed',
              description: `قفل وجه برای معامله ${contract.title}`,
              createdAt: serverTimestamp()
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
          if (!useLocalFallback) {
            await addDoc(collection(db, 'transactions'), {
              user_id: String(contract.seller_id),
              contract_id: String(contract.contract_id),
              amount: Number(contract.amount),
              type: 'escrow_release',
              status: 'completed',
              description: `تسویه نهایی معامله ${contract.title}`,
              createdAt: serverTimestamp()
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

  if (['draft', 'awaiting_payment'].includes(contract.status) && (isBuyer || isSeller)) {
    actions.push({
      label: 'لغو معامله',
      variant: 'secondary',
      action: async () => {
        await updateStatus('cancelled');
      }
    });
  }

  if (!['completed', 'cancelled', 'disputed'].includes(contract.status) && (isBuyer || isSeller)) {
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
