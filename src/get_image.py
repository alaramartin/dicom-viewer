import pydicom
import sys
from PIL import Image
import base64
from io import BytesIO

def convertImageToBase64(pil_image):
    buffered = BytesIO()
    pil_image.save(buffered, format="JPEG")
    img_str = base64.b64encode(buffered.getvalue())
    # decode to string
    return img_str.decode('utf-8')

if __name__ == "__main__":
    if len(sys.argv) > 1:
        print(f"pathname: {sys.argv[1]}")
        filepath = sys.argv[1]
        # get the pixel array of the image
        dcm_image = pydicom.dcmread(filepath)
        image_pixel_array = dcm_image.pixel_array
        # convert pixel array to PIL Image
        image_to_display = Image.fromarray(image_pixel_array)
        # convert to grayscale if needed
        if image_to_display.mode != 'RGB':
            image_to_display = image_to_display.convert('L')
        # return base64 string to stdout
        print(convertImageToBase64(image_to_display))
    else:
        print("No arguments provided.")