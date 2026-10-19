"""Staging CLI integration without invoking PDF engines or stock research."""
import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tools'))
import check_thesis
import md_to_pdf
from test_check_thesis_gate_e2e import build_run, SYMBOL


class DeliveryStagingTests(unittest.TestCase):
    def test_gate_reads_explicit_staged_position(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = build_run(root, '判断。')
            canonical = root / 'positions' / (SYMBOL + '.md')
            stage = root / 'staged.md'
            stage.write_bytes(canonical.read_bytes())
            canonical.write_text('manual old position', encoding='utf-8')
            stream = io.StringIO()
            with patch.object(sys, 'argv', ['check_thesis.py', SYMBOL, str(report), '--position', str(stage)]), contextlib.redirect_stdout(stream):
                check_thesis.main()
            self.assertNotIn('档案未更新', stream.getvalue())
            self.assertNotIn('档案不存在', stream.getvalue())
            self.assertIn('全部硬约束满足', stream.getvalue())
            self.assertEqual(canonical.read_text(), 'manual old position')

    def test_pdf_cli_selects_external_output_and_prints_safely(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'report.md'
            source.write_text('# synthetic\n', encoding='utf-8')
            output = root / 'staged' / 'report.pdf'
            with patch.object(sys, 'argv', ['md_to_pdf.py', '--md', str(source), '--output', str(output)]), patch.object(md_to_pdf, 'build_pdf', return_value=output) as build, contextlib.redirect_stdout(io.StringIO()) as stream:
                md_to_pdf.main()
            build.assert_called_once_with(source, output_path=output)
            self.assertIn(str(output), stream.getvalue())

    def test_pdf_build_targets_staging_in_both_render_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'report.md'
            source.write_text('# synthetic\n', encoding='utf-8')
            header = root / 'header.tex'
            header.write_text('')
            output = root / 'staged' / 'report.pdf'
            with patch.object(md_to_pdf, 'require'), patch.object(md_to_pdf.shutil, 'which', return_value='/synthetic'), patch.object(md_to_pdf, 'HEADER_TEX', header), patch.object(md_to_pdf.subprocess, 'run') as run, patch.object(md_to_pdf, 'build_pdf_via_chrome', return_value=True) as chrome, contextlib.redirect_stderr(io.StringIO()):
                run.return_value.returncode = 1
                run.return_value.stderr = ''
                run.return_value.stdout = ''
                self.assertEqual(md_to_pdf.build_pdf(source, output_path=output), output)
            self.assertTrue(output.parent.is_dir())
            self.assertIn(str(output), run.call_args.args[0])
            self.assertEqual(chrome.call_args.args[1], output)
