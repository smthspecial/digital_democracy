"""Synthetic component feasibility experiment, never a production voting service.

Run with the pinned official SDK's Python environment, from its checkout.
The SDK's default test harness uses tiny TestOnly primes. This runner calls
the official example steps directly with Standard 4096/256-bit parameters.
All trustee shares are deliberately co-located in this disposable experiment;
that does not qualify independently administered production custody.
"""
import argparse
from dataclasses import replace
import json
import os
from pathlib import Path
import subprocess
import sys

REVISION = 'a9753841f5082d1c35bdc1b053aade74778662b7'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    assert revision == REVISION, 'Reference implementation revision mismatch'
    os.environ['PRIME_OPTION'] = 'Standard'
    os.chdir(source)
    sys.path[:0] = [str(source), str(source/'src')]
    from electionguard.constants import get_large_prime, get_small_prime
    from electionguard.group import add_q
    from tests.integration.test_end_to_end_election import TestEndToEndElection
    from tests.property.test_decryption_mediator import TestDecryptionMediator

    checks = []
    assert get_large_prime().bit_length() == 4096 and get_small_prime().bit_length() == 256
    election = TestEndToEndElection('test_end_to_end_election')
    election.step_0_configure_election()
    election.step_1_key_ceremony()
    election.step_2_encrypt_votes()
    context = election.context
    for ballot in election.ciphertext_ballots:
        assert ballot.is_valid_encryption(election.internal_manifest.manifest_hash, context.elgamal_public_key, context.crypto_extended_base_hash)
    checks.append({'case': 'standard-group encrypted ballot proofs verify', 'passed': True})
    selection = election.ciphertext_ballots[0].contests[0].ballot_selections[0]
    proof = selection.proof
    assert proof is not None
    bad = replace(proof, proof_zero_response=add_q(proof.proof_zero_response, 1))
    assert not bad.is_valid(selection.ciphertext, context.elgamal_public_key, context.crypto_extended_base_hash)
    checks.append({'case': 'tampered proof response rejected', 'passed': True})
    assert not proof.is_valid(selection.ciphertext, context.elgamal_public_key, add_q(context.crypto_extended_base_hash, 1))
    checks.append({'case': 'wrong election proof domain rejected', 'passed': True})
    election.step_3_cast_and_spoil()
    election.step_4_decrypt_tally()
    election.step_5_publish()
    checks.append({'case': 'encrypted accumulation, trustee decryption and published-record reload agree with synthetic tally', 'passed': True})
    threshold = TestDecryptionMediator('test_get_plaintext_with_a_missing_guardian')
    threshold.setUp()
    threshold.test_get_plaintext_with_a_missing_guardian()
    checks.append({'case': '2-of-3 compensated trustee decryption agrees with synthetic tally', 'passed': True})
    assert os.environ['PRIME_OPTION'] == 'Standard' and get_large_prime().bit_length() == 4096
    args.output.write_text(json.dumps({'candidate': 'ElectionGuard Python 1.4.0', 'source': 'https://github.com/Election-Tech-Initiative/electionguard-python', 'revision': revision, 'license': 'MIT', 'primeBits': 4096, 'subgroupBits': 256, 'checks': checks, 'passed': len(checks), 'productionApproved': False, 'limitations': ['Synthetic official SDK examples; no application integration', 'All trustee shares on one disposable machine', 'Anonymous credentials and submission separation absent', 'Receipt-freeness and coercion resistance not established', 'Required ranked/scored methods not qualified', 'No independent composition review']}, indent=2)+'\n')
    print(f'{len(checks)} standard-parameter cryptography prototype checks passed; production not approved')


if __name__ == '__main__': main()
