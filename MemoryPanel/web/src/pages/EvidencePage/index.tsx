import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabPanel } from 'tea-component';
import { useTeams } from '@/services';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { EvidenceWorkspace } from '@/components/evidence/EvidenceWorkspace';

export function EvidencePage() {
  const { t } = useTranslation();
  const { activeTeamId, activeTeam } = useTeams();
  const [tab, setTab] = useState<'runs' | 'candidates' | 'evaluations'>('runs');
  return (
    <div className="_evidence-workspace">
      <AssetPageHeader
        title={t('evidence.title')}
        scope={activeTeam?.name ?? t('evidence.selectTeam')}
        subtitle={t('evidence.stateHint')}
      />
      <Tabs
        activeId={tab}
        onActive={(item) => setTab(item.id as typeof tab)}
        tabs={[
          { id: 'runs', label: t('evidence.tab.assets') },
          { id: 'candidates', label: t('evidence.tab.candidates') },
          { id: 'evaluations', label: t('evidence.tab.evaluations') },
        ]}
      >
        {(['runs', 'candidates', 'evaluations'] as const).map((id) => (
          <TabPanel key={id} id={id}>
            {tab === id && <EvidenceWorkspace teamId={activeTeamId ?? ''} mode={id} />}
          </TabPanel>
        ))}
      </Tabs>
    </div>
  );
}
