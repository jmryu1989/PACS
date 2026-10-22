import { launchStateService } from './state-service';
import { runStateConversion } from './state-conversion';

// Exit is part of ownership: only process death releases writer.lock, even after incomplete cleanup.
// The launcher's entry mode selects the root: `state-serve-v3`/`state-serve-v4` serve (KIN_EMR_STATE_FORMAT);
// `state-convert-v4`/`state-export-v3` run the one-shot conversion root (KIN_EMR_STATE_MODE) and exit.
const root = process.env.KIN_EMR_STATE_MODE !== undefined ? runStateConversion() : launchStateService();
void root.then(code => process.exit(code), () => {
  process.stderr.write('EMR_STATE_FAILED\n');
  process.exit(1);
});
