
function kinCreateCTPresets() {
  let restore;
  return {
    id: 'kin.ct-presets',
    onModeEnter({ servicesManager, commandsManager }) {
      restore?.();
      const native = commandsManager.getCommand('setWindowLevel', 'CORNERSTONE');
      if (!native?.commandFn) return;
      // Mode hotkeys supply these five named CT presets; the viewport menu uses a separate native command.
      const names = ['Soft tissue', 'Lung', 'Liver', 'Bone', 'Brain'];
      const guarded = { ...native, commandFn(props) {
        const index = names.indexOf(props.description);
        return index < 0 ? native.commandFn(props) : kinApplyCTPreset(servicesManager.services, commandsManager, index);
      } };
      commandsManager.registerCommand('CORNERSTONE', 'setWindowLevel', guarded);
      // S5-UI7: the Display Scope Presets buttons read these names and the table kinApplyCTPreset reads, and apply through it.
      const exposed = { names: [...names], preset: index => servicesManager.services.customizationService?.get?.('cornerstone.windowLevelPresets')?.presets?.CT?.[index], apply: index => kinApplyCTPreset(servicesManager.services, commandsManager, index) };
      window.kinCTPresets = exposed;
      restore = () => {
        if (commandsManager.getCommand('setWindowLevel', 'CORNERSTONE') === guarded) commandsManager.registerCommand('CORNERSTONE', 'setWindowLevel', native);
        if (window.kinCTPresets === exposed) delete window.kinCTPresets;
      };
    },
    onModeExit() { restore?.(); restore = null; },
  };
}
