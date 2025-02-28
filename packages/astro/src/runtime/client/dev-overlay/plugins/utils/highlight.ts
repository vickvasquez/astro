import type { DevOverlayHighlight } from '../../ui-library/highlight.js';
import type { Icon } from '../../ui-library/icons.js';

export function createHighlight(rect: DOMRect, icon?: Icon) {
	const highlight = document.createElement('astro-dev-toolbar-highlight');
	if (icon) highlight.icon = icon;

	highlight.tabIndex = 0;

	if (rect.width === 0 || rect.height === 0) {
		highlight.style.display = 'none';
	} else {
		positionHighlight(highlight, rect);
	}
	return highlight;
}

// Figures out the element's z-index and position, based on it's parents.
export function getElementsPositionInDocument(el: Element) {
	let highestZIndex = 0;
	let fixed = false;
	let current: Element | ParentNode | null = el;
	while (current instanceof Element) {
		// This is the expensive part, we are calling getComputedStyle which triggers layout
		// all the way up the tree. We are only doing so when the app initializes, so the cost is one-time
		// If perf becomes an issue we'll want to refactor this somehow so that it reads this info in a rAF
		let style = getComputedStyle(current);
		let zIndex = Number(style.zIndex);
		if (!Number.isNaN(zIndex) && zIndex > highestZIndex) {
			highestZIndex = zIndex;
		}
		if (style.position === 'fixed') {
			fixed = true;
		}
		current = current.parentNode;
	}
	return {
		zIndex: highestZIndex + 1,
		fixed,
	};
}

export function positionHighlight(highlight: DevOverlayHighlight, rect: DOMRect) {
	highlight.style.display = 'block';
	// If the highlight is fixed, don't position based on scroll
	const scrollY = highlight.style.position === 'fixed' ? 0 : window.scrollY;
	// Make an highlight that is 10px bigger than the element on all sides
	highlight.style.top = `${Math.max(rect.top + scrollY - 10, 0)}px`;
	highlight.style.left = `${Math.max(rect.left + window.scrollX - 10, 0)}px`;
	highlight.style.width = `${rect.width + 15}px`;
	highlight.style.height = `${rect.height + 15}px`;
}

export function attachTooltipToHighlight(
	highlight: DevOverlayHighlight,
	tooltip: HTMLElement,
	originalElement: Element
) {
	highlight.shadowRoot.append(tooltip);

	(['mouseover', 'focus'] as const).forEach((event) => {
		highlight.addEventListener(event, () => {
			tooltip.dataset.show = 'true';
			const originalRect = originalElement.getBoundingClientRect();
			const dialogRect = tooltip.getBoundingClientRect();

			// If the tooltip is going to be off the screen, show it above the element instead
			if (originalRect.top < dialogRect.height) {
				// Not enough space above, show below
				tooltip.style.top = `${originalRect.height + 15}px`;
			} else {
				tooltip.style.top = `-${tooltip.offsetHeight}px`;
			}
		});
	});

	(['mouseout', 'blur'] as const).forEach((event) => {
		highlight.addEventListener(event, () => {
			tooltip.dataset.show = 'false';
		});
	});
}
