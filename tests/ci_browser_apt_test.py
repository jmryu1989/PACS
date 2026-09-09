"""CI browser setup preserves package verification and unrelated sources."""
import importlib.util
from pathlib import Path
import os,unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('browser_apt',Path(__file__).resolve().parents[1]/'scripts/ci_browser_apt.py')
apt=importlib.util.module_from_spec(spec);spec.loader.exec_module(apt)

class BrowserAptTests(unittest.TestCase):
 def test_list_filters_only_active_exact_google_chrome_repositories(self):
  text='deb [arch=amd64 signed-by=/key.gpg] https://dl.google.com/linux/chrome-stable/deb/ stable main\n'
  other='deb https://archive.ubuntu.com/ubuntu noble main\n# deb https://dl.google.com/linux/chrome/deb stable main\ndeb https://dl.google.com.evil.invalid/linux/chrome/deb stable main\n'
  changed=apt.without_chrome(text+other,'.list')
  self.assertEqual(changed,'# Disabled for pinned Playwright CI: '+text+other)
  self.assertEqual(apt.without_chrome(changed,'.list'),changed)
 def test_deb822_preserves_ubuntu_and_signed_by(self):
  ubuntu='Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\nComponents: main\nSigned-By: /ubuntu.gpg\n'
  google='Types: deb\nURIs: https://dl.google.com/linux/chrome-stable/deb/\nSuites: stable\nComponents: main\nSigned-By: /google.gpg\nEnabled: yes\n'
  changed=apt.without_chrome(ubuntu+'\n'+google,'.sources')
  self.assertEqual(changed,ubuntu+'\n'+google.replace('Enabled: yes','Enabled: no'))
  self.assertEqual(apt.without_chrome(changed,'.sources'),changed)
 def test_deb822_multiline_mixed_uri_keeps_other_mirror(self):
  text='Types: deb\nURIs: https://dl.google.com/linux/chrome/deb\n https://example.invalid/mirror\nSuites: stable\nSigned-By: /key.gpg\n'
  self.assertEqual(apt.without_chrome(text,'.sources'),'Types: deb\nURIs: https://example.invalid/mirror\nSuites: stable\nSigned-By: /key.gpg\n')
  single=apt.without_chrome('URIs: https://dl.google.com/linux/chrome/deb\nSuites: stable\n','.sources')
  self.assertIn('Enabled: no',single)
 def test_non_ci_execution_refuses_before_filesystem_changes(self):
  with patch.dict(os.environ,{},clear=True),patch.object(apt.Path,'iterdir',side_effect=AssertionError('must not inspect sources')):
   with self.assertRaises(RuntimeError):apt.main()
if __name__=='__main__':unittest.main(verbosity=2)
