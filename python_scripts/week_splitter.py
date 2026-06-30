import re
import os
from pypdf import PdfReader, PdfWriter

DELIMITER_REGEX = re.compile(r"Week\s*\d{1,2}\s*Questions?")


def get_week_number(text):
    match = re.search(r"\d{1,2}", text)
    return match.group(0) if match else "unknown"


def split_pdf_by_pages(pdf_path, output_dir="output_sections"):
    os.makedirs(output_dir, exist_ok=True)

    reader = PdfReader(pdf_path)

    current_writer = None
    current_week = None

    def save_current():
        nonlocal current_writer, current_week
        if current_writer and current_week is not None:
            out_path = os.path.join(output_dir, f"week_{current_week}.pdf")
            with open(out_path, "wb") as f:
                current_writer.write(f)
            print(f"Saved: {out_path}")

    for page in reader.pages:
        text = page.extract_text() or ""

        match = DELIMITER_REGEX.search(text)

        if match:
            # New section starts → save previous one
            save_current()

            current_writer = PdfWriter()
            current_week = get_week_number(match.group(0))

        # If we haven't hit a section yet, skip pages until first match
        if current_writer is not None:
            current_writer.add_page(page)

    # Save last section
    save_current()


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python split_pdf.py input.pdf")
        sys.exit(1)

    split_pdf_by_pages(sys.argv[1])