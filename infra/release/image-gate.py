#!/usr/bin/env python3
"""Fail closed on malformed scanner output, unsupported OS or high/critical CVEs."""
import argparse
import json
from datetime import date
from pathlib import Path


def evaluate(report, reviews=(), today=None):
    today = today or date.today()
    if report.get('SchemaVersion') != 2 or not isinstance(report.get('Results'), list) or not report['Results']:
        raise ValueError('Invalid or incomplete image scanner report')
    if not isinstance(report.get('Metadata'), dict):
        raise ValueError('Missing image metadata')
    failures, notices = [], []
    if report['Metadata'].get('OS', {}).get('EOSL'):
        failures.append({'reason': 'unsupported OS'})
    for result in report['Results']:
        for finding in result.get('Vulnerabilities') or []:
            item = {key: finding.get(key) for key in ('VulnerabilityID', 'PkgName', 'InstalledVersion', 'FixedVersion', 'Severity')}
            item['target'] = result['Target']
            (failures if finding.get('Severity') in ('HIGH', 'CRITICAL') else notices).append(item)
    for notice in notices:
        reviewed = any(all(review.get(key) == notice.get(key) for key in ('VulnerabilityID', 'PkgName', 'InstalledVersion')) and
            review.get('owner') and review.get('reason') and date.fromisoformat(review['reviewBy']) >= today for review in reviews)
        if not reviewed:
            failures.append({**notice, 'reason': 'unreviewed or expired lower-severity advisory'})
    return {'passed': not failures, 'blocking': failures, 'reviewRequired': notices}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('report', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--reviews', type=Path, default=Path(__file__).resolve().parents[2]/'testing/security/image-advisory-reviews.json')
    args = parser.parse_args()
    result = evaluate(json.loads(args.report.read_text()), json.loads(args.reviews.read_text()))
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(f"Image gate: {len(result['blocking'])} blocking findings; {len(result['reviewRequired'])} lower-severity notices")
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
