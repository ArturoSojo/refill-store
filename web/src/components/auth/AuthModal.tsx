import { Modal } from '@/components/ui/Modal';
import { AuthCard } from './AuthCard';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function AuthModal({ open, onClose, onSuccess }: AuthModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      containerClassName="z-[70]"
    >
      <div className="py-2">
        <AuthCard isModal onSuccess={onSuccess ?? onClose} />
      </div>
    </Modal>
  );
}
