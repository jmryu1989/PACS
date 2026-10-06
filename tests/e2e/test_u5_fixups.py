# coding: utf-8
"""S7-U5 fix-round regressions on a hosted stack (final review part 1, blocker 3): the authored cases that pin this
round's fixes - the saved split size re-applied when the work area changes size (roam_01) and a failed write that
starts again from a normal read (roam_04b), a version 1-3 Job restore that reports only what the cells show once the
viewer settled (job_03), a saved view restored across browsers with its zoom (favorite_view_02), and typed text,
annotations and the report kept across display controls (display_04). Each source module's own load_tests still
selects all of its cases for local live runs; this module selects exactly these five, once each."""
import unittest
from test_workspace_roaming import WorkspaceRoamingE2E
from test_viewer_jobs import ViewerJobsE2E
from test_favorite_view import FavoriteViewE2E
from test_display_controls import DisplayControlsE2E

# scripts/run-tests.py accepts only cases whose class is declared in the selected module, so each subclass carries its
# authored cases unchanged and declares none itself; the inherited cases not named below stay out.
class U5FixupRoamingE2E(WorkspaceRoamingE2E):pass
class U5FixupJobsE2E(ViewerJobsE2E):pass
class U5FixupFavoriteViewE2E(FavoriteViewE2E):pass
class U5FixupDisplayE2E(DisplayControlsE2E):pass

CASES=((U5FixupRoamingE2E,'test_roam_01_two_browsers_all_panels_and_report'),
       (U5FixupRoamingE2E,'test_roam_04b_write_failure_starts_from_a_normal_read'),
       (U5FixupJobsE2E,'test_job_03_two_study_native_display_new_browser_restore'),
       (U5FixupFavoriteViewE2E,'test_favorite_view_02_connect_cross_browser_and_restore'),
       (U5FixupDisplayE2E,'test_display_04_input_annotation_and_reporting_preservation'))

def load_tests(loader,tests,pattern):return unittest.TestSuite(cls(name) for cls,name in CASES)
if __name__=='__main__':unittest.main(verbosity=2)
