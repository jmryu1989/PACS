"""Operate the served image toolbar, including embedded OHIF's retained toolbar."""
from playwright.sync_api import expect


LABELS = {'WindowLevel': 'Window Level', 'ArrowAnnotate': 'Annotation',
          'EllipticalROI': 'Ellipse', 'RectangleROI': 'Rectangle',
          'ImageSliceSync': 'Image Slice Sync', 'StackScroll': 'Stack Scroll',
          'flipHorizontal': 'Flip Horizontal', 'rotate-right': 'Rotate Right',
          'invert': 'Invert', 'Reset': 'Reset View'}


def image_tool(viewer, tool):
    toolbar = viewer.get_by_role('region', name='Image Tools', exact=True)
    if viewer.evaluate('window.top === window'):
        expect(toolbar).to_be_visible()
        # The shell can paint before its study workspaces finish restoring.
        # Wait for the same public readiness boundary that accepts a tool action.
        viewer.wait_for_function('''() => {
          const history=window.kinViewerHistoryWorkspaceState?.(), jobs=window.kinViewerJobWorkspaceState?.();
          return history && jobs && !history.busy && !jobs.busy &&
            !document.body.classList.contains('kin-patient-switching');
        }''')
        button = toolbar.get_by_role('button', name=LABELS.get(tool, tool), exact=True)
        more = toolbar.locator('details')
        if more.get_by_role('button', name=LABELS.get(tool, tool), exact=True, include_hidden=True).count() and more.get_attribute('open') is None:
            more.locator('summary').click()
        expect(button).to_be_visible()
        return button
    # U2 is a top-level shell. Embedded viewers still use OHIF's native toolbar.
    direct = viewer.locator(f'#root button[data-cy="{tool}"]')
    if direct.is_visible():
        return direct
    section = 'MeasurementTools' if tool in {'ArrowAnnotate', 'Length', 'EllipticalROI', 'RectangleROI', 'Angle'} else 'MoreTools'
    viewer.locator(f'[data-cy="{section}-split-button-secondary"]').click()
    return viewer.locator('#root').get_by_text(LABELS.get(tool, tool), exact=True)


def select_image_tool(viewer, tool):
    image_tool(viewer, tool).click()
    toolbar = viewer.get_by_role('region', name='Image Tools', exact=True)
    if toolbar.count():
        more = toolbar.locator('details[open]')
        if more.count():
            more.locator('summary').click()


def display_transform(viewer, action):
    if action == 'v':
        # F8 leaves single-key defaults undecided. Use the existing display control.
        tab = viewer.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]')
        previous = viewer.locator('#kin-workspace-dock nav button[aria-expanded="true"]')
        previous_id = previous.get_attribute('aria-controls') if previous.count() else None
        if tab.get_attribute('aria-expanded') != 'true':
            tab.click()
        scope = viewer.locator('#kin-display-scope')
        scope.get_by_role('button', name='Active', exact=True).click()
        scope.get_by_role('button', name='Flip V', exact=True).click()
        if previous_id != 'kin-viewer-layout':
            if previous_id:
                viewer.locator(f'#kin-workspace-dock nav button[aria-controls="{previous_id}"]').click()
            else:
                tab.click()
        viewer.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    else:
        select_image_tool(viewer, {'h': 'flipHorizontal', 'r': 'rotate-right', 'i': 'invert'}[action])


def native_back(viewer):
    # OHIF's unlabelled Back icon moved down when the patient strip was added.
    header = viewer.locator('#kin-viewer-brand').locator('xpath=ancestor::div[contains(@class,"bg-secondary-dark")][1]')
    header.locator('svg').first.click()
