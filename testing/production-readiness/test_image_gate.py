import importlib.util
from pathlib import Path
import unittest
from datetime import date
spec = importlib.util.spec_from_file_location('image_gate', Path(__file__).resolve().parents[2] / 'infra/release/image-gate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ImageGateTests(unittest.TestCase):
    def report(self, severity=None):
        findings = [{'Severity': severity, 'VulnerabilityID': 'CVE-test'}] if severity else []
        return {'SchemaVersion': 2, 'Metadata': {'OS': {}}, 'Results': [{'Target': 'image', 'Vulnerabilities': findings}]}
    def test_clean_and_notice_reports(self):
        self.assertTrue(module.evaluate(self.report())['passed'])
        self.assertFalse(module.evaluate(self.report('LOW'))['passed'])
    def test_reviews_are_exact_expiring_and_never_allow_high(self):
        review = {'VulnerabilityID': 'CVE-test', 'PkgName': None, 'InstalledVersion': None, 'owner': 'maintainer', 'reason': 'test review', 'reviewBy': '2026-11-07'}
        self.assertTrue(module.evaluate(self.report('LOW'), [review], date(2026, 10, 8))['passed'])
        self.assertFalse(module.evaluate(self.report('LOW'), [review], date(2026, 11, 8))['passed'])
        self.assertFalse(module.evaluate(self.report('HIGH'), [review], date(2026, 10, 8))['passed'])
        wrong = {**review, 'VulnerabilityID': 'CVE-other'}
        self.assertFalse(module.evaluate(self.report('LOW'), [wrong], date(2026, 10, 8))['passed'])
    def test_high_and_unsupported_os_block(self):
        self.assertFalse(module.evaluate(self.report('HIGH'))['passed'])
        report = self.report(); report['Metadata']['OS']['EOSL'] = True
        self.assertFalse(module.evaluate(report)['passed'])
    def test_scanner_failure_cannot_pass(self):
        for report in [{}, {'SchemaVersion': 2, 'Results': []}]:
            with self.assertRaises(ValueError): module.evaluate(report)

if __name__ == '__main__': unittest.main()
