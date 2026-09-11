from app.classify import ROLE_CONTAINER_DOOR, ROLE_INTERNAL, ROLE_LABEL, ImageInfo, classify_images
from app.vision import Code


def test_classify_picks_label_by_qr_code():
    images = [
        ImageInfo(index=0, filename="a.jpg", ocr_text="MRKU 806 865 4", codes=[]),
        ImageInfo(index=1, filename="b.jpg", ocr_text="", codes=[Code(type="QRCODE", data="DWH123")]),
        ImageInfo(index=2, filename="c.jpg", ocr_text="", codes=[]),
    ]
    roles = classify_images(images)
    assert roles == [ROLE_CONTAINER_DOOR, ROLE_LABEL, ROLE_INTERNAL]


def test_classify_picks_label_by_keywords_when_no_code():
    images = [
        ImageInfo(index=0, filename="a.jpg", ocr_text="", codes=[]),
        ImageInfo(index=1, filename="b.jpg", ocr_text="Certification\nFlexitank\nLot No: 123", codes=[]),
    ]
    roles = classify_images(images)
    assert roles[1] == ROLE_LABEL
    assert roles[0] == ROLE_INTERNAL


def test_classify_no_label_found_defaults_to_internal():
    images = [
        ImageInfo(index=0, filename="a.jpg", ocr_text="", codes=[]),
        ImageInfo(index=1, filename="b.jpg", ocr_text="", codes=[]),
    ]
    roles = classify_images(images)
    assert roles == [ROLE_INTERNAL, ROLE_INTERNAL]
