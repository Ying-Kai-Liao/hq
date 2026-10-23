import { CardForm, CardSection } from '../../components/Controls'
import { ModalHeader, SheetPage } from '../../components/Overlay'
import { VStack } from '../../components/Stack'
import { Text } from '../../components/Text'

/** Settings → Open-source licenses: the attribution Apache-2.0 asks for, and the one place the upstream project is named. */
export function LicensesSheet() {
  return (
    <SheetPage>
      <ModalHeader title="Open-source licenses" />
      <CardForm>
        <CardSection>
          <VStack gap={2} className="settings-stack">
            <span>Codync</span>
            <Text size="footnote" tone="secondary">Kith began as a fork of Codync by leepokai, used under the Apache License 2.0.</Text>
          </VStack>
          <button className="settings-link" onClick={() => window.codync.app.openExternal('https://github.com/leepokai/Codync')}>
            Codync on GitHub
          </button>
        </CardSection>
      </CardForm>
    </SheetPage>
  )
}
