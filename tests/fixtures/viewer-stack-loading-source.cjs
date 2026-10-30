/*
 * Navigation/resize/indicator methods from the pinned Cornerstone3D/OHIF bundles.
 * MIT License — Copyright (c) 2019 Open Health Imaging Foundation.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * Source: https://github.com/cornerstonejs/cornerstone3D/blob/main/LICENSE
 * Pinned source: app.bundle.6656ed549d35896854f2.js, SHA256
 * 4fc18be2b7ae02369093d0505ae3241c9d78cb7396aebef4a0e01b8534f5ff58.
 */
// Native loading/navigation and resize methods, retained as executable behaviour fixtures.
// Also from 1185.bundle.ec6a71537e54fa339268.js (viewport service) and
// 9611.bundle.767595c93877e5166c03.js (loading indicator). No source-text assertions.
module.exports = ({ cache, enums, triggerEvent, window, clearTimeout, setTimeout }) => ({
  stack: {
    async _setImageIdIndex(imageIdIndex) {
        if (imageIdIndex >= this.imageIds.length) {
            throw new Error(`ImageIdIndex provided ${imageIdIndex} is invalid, the stack only has ${this.imageIds.length} elements`);
        }
        this.currentImageIdIndex = imageIdIndex;
        this.hasPixelSpacing = true;
        this.viewportStatus = enums.ViewportStatus.PRE_RENDER;
        const imageId = await this._loadAndDisplayImage(this.imageIds[imageIdIndex], imageIdIndex);
        if (this.perImageIdDefaultProperties.size >= 1) {
            const defaultProperties = this.perImageIdDefaultProperties.get(imageId);
            if (defaultProperties !== undefined) {
                this.setProperties(defaultProperties);
            }
            else if (this.globalDefaultProperties !== undefined) {
                this.setProperties(this.globalDefaultProperties);
            }
        }
        return imageId;
    },
    scroll(delta, debounce = true, loop = false) {
        const imageIds = this.imageIds;
        const currentTargetImageIdIndex = this.targetImageIdIndex;
        const numberOfFrames = imageIds.length;
        let newTargetImageIdIndex = currentTargetImageIdIndex + delta;
        newTargetImageIdIndex = Math.max(0, newTargetImageIdIndex);
        if (loop) {
            newTargetImageIdIndex = newTargetImageIdIndex % numberOfFrames;
        }
        else {
            newTargetImageIdIndex = Math.min(numberOfFrames - 1, newTargetImageIdIndex);
        }
        this.targetImageIdIndex = newTargetImageIdIndex;
        const targetImageId = imageIds[newTargetImageIdIndex];
        const imageAlreadyLoaded = cache/* default */.Ay.isLoaded(targetImageId);
        if (imageAlreadyLoaded || !debounce) {
            this.setImageIdIndex(newTargetImageIdIndex);
        }
        else {
            clearTimeout(this.debouncedTimeout);
            this.debouncedTimeout = window.setTimeout(() => {
                this.setImageIdIndex(newTargetImageIdIndex);
            }, 40);
        }
        const eventData = {
            newImageIdIndex: newTargetImageIdIndex,
            imageId: targetImageId,
            direction: delta,
        };
        if (newTargetImageIdIndex !== currentTargetImageIdIndex) {
            (0,triggerEvent/* default */.A)(this.element, enums.Events.STACK_VIEWPORT_SCROLL, eventData);
        }
    },
    setImageIdIndex(imageIdIndex) {
        this._throwIfDestroyed();
        if (this.currentImageIdIndex === imageIdIndex) {
            return Promise.resolve(this.getCurrentImageId());
        }
        const imageIdPromise = this._setImageIdIndex(imageIdIndex);
        return imageIdPromise;
    },
    setViewReference(viewRef) {
        if (!viewRef) {
            return;
        }
        const { referencedImageId, sliceIndex } = viewRef;
        if (typeof sliceIndex === 'number' &&
            referencedImageId &&
            referencedImageId === this.imageIds[sliceIndex]) {
            this.scroll(sliceIndex - this.targetImageIdIndex);
        }
        else {
            const foundIndex = this.imageIds.indexOf(referencedImageId);
            if (foundIndex !== -1) {
                this.scroll(foundIndex - this.targetImageIdIndex);
            }
            else {
                throw new Error('Unsupported - referenced image id not found');
            }
        }
    },
  },
  service: {
  setPresentations(viewportId, presentations) {
    const viewport = this.getCornerstoneViewport(viewportId);
    if (!viewport || !presentations) {
      return;
    }
    const {
      lutPresentation,
      positionPresentation,
      segmentationPresentation
    } = presentations;

    // Always set the segmentation presentation first, since there might be some
    // lutpresentation states that need to be set on the segmentation
    // Todo: i think we should even await this
    this._setSegmentationPresentation(viewport, segmentationPresentation);
    this._setLutPresentation(viewport, lutPresentation);
    this._setPositionPresentation(viewport, {
      ...positionPresentation,
      viewportId
    });
  },
  performResize() {
    const isImmediate = false;
    try {
      const viewports = this.getRenderingEngine().getViewports();

      // Store the current position presentations for each viewport.
      viewports.forEach(({
        id: viewportId
      }) => {
        const presentation = this._getPositionPresentation(viewportId);
        this.beforeResizePositionPresentations.set(viewportId, presentation);
      });

      // Resize the rendering engine and render.
      const renderingEngine = this.renderingEngine;
      renderingEngine.resize(isImmediate);
      renderingEngine.render();

      // Reset the camera for viewports that should reset their camera on resize,
      // which means only those viewports that have a zoom level of 1.
      this.beforeResizePositionPresentations.forEach((positionPresentation, viewportId) => {
        this.setPresentations(viewportId, {
          positionPresentation
        });
      });

      // Resize and render the rendering engine again.
      renderingEngine.resize(isImmediate);
      renderingEngine.render();
    } catch (e) {
      // This can happen if the resize is too close to navigation or shutdown
      console.warn('Caught resize exception', e);
    }
  },
  _setPositionPresentation(viewport, positionPresentation) {
    const viewRef = positionPresentation?.viewReference;
    if (viewRef) {
      viewport.setViewReference(viewRef);
    }
    const viewPresentation = positionPresentation?.viewPresentation;
    if (viewPresentation) {
      viewport.setViewPresentation(viewPresentation);
    }
  },
  },
  indicator(setLoading) {
    const loadIndicatorRef = { current: null };
  const setLoadingState = evt => {
    clearTimeout(loadIndicatorRef.current);
    loadIndicatorRef.current = setTimeout(() => {
      setLoading(true);
    }, 50);
  };
  const setFinishLoadingState = evt => {
    clearTimeout(loadIndicatorRef.current);
    setLoading(false);
  };
    return { scroll: setLoadingState, loaded: setFinishLoadingState };
  },
});
