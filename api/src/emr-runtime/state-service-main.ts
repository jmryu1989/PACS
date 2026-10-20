import { launchStateService } from './state-service';

// Exit is part of ownership: only process death releases writer.lock, even after incomplete cleanup.
void launchStateService().then(code => process.exit(code), () => {
  process.stderr.write('EMR_STATE_FAILED\n');
  process.exit(1);
});
