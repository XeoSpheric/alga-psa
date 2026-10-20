'use client';

import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@alga-psa/ui/components/Dialog';
import { Button } from '@alga-psa/ui/components/Button';
import { Input } from '@alga-psa/ui/components/Input';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import { DASHBOARD_NAME_MAX_LENGTH } from '@/lib/dashboards/types';

/** Name prompt shared by "New dashboard" and "Rename". */
export function DashboardNameDialog({
  id,
  isOpen,
  title,
  submitLabel,
  initialName = '',
  isSubmitting = false,
  onClose,
  onSubmit,
}: {
  id: string;
  isOpen: boolean;
  title: string;
  submitLabel: string;
  initialName?: string;
  isSubmitting?: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useTranslation('msp/dashboard');
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (isOpen) setName(initialName);
  }, [isOpen, initialName]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= DASHBOARD_NAME_MAX_LENGTH && !isSubmitting;

  return (
    <Dialog
      id={id}
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      className="max-w-md"
      footer={
        <div className="flex justify-end gap-2">
          <Button id={`${id}-cancel`} variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('actions.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button id={`${id}-submit`} onClick={() => onSubmit(trimmed)} disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit(trimmed);
          }}
        >
          <Input
            id={`${id}-name`}
            label={t('dashboards.nameLabel', { defaultValue: 'Dashboard name' })}
            value={name}
            maxLength={DASHBOARD_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
