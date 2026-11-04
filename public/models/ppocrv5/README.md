# PP-OCRv5 mobile models

Text recognition for scanned drawings uses PaddleOCR's PP-OCRv5 mobile
models (multilingual: Latin script, Chinese, Japanese), run in the browser
with ONNX Runtime Web.

| File | Model | Size |
| --- | --- | --- |
| `det.ort` | PP-OCRv5_mobile_det (text detection), ORT format | 4.9 MB |
| `rec.onnx` | PP-OCRv5_mobile_rec (text recognition), ONNX | 16.6 MB |
| `dict.txt` | ppocrv5_dict.txt (character dictionary) | 74 KB |

Source: [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) by the
PaddlePaddle Authors, Apache License 2.0. The ONNX/ORT exports are the
unmodified files from
[PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models)
(Apache-2.0), mirrored at
[huggingface.co/pdfmarkdownapp/ppu-paddle-ocr-models](https://huggingface.co/pdfmarkdownapp/ppu-paddle-ocr-models).

SHA-256:

```
30acfc4e21f2a23669d01a75aaeb92190f96874613108a0f7086bed264420abc  det.ort
d253c3cbee6e507828a5271a30ab0ec8ae7c2a99d0cc8e6f844fe380809d22b3  rec.onnx
9dfc80c50b6cb07399a47a7cf25d11db475fb4ad0e1fc96b2eff6467c8166ff3  dict.txt
```
