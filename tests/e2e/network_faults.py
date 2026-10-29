"""One-request faults without toggling Chromium interception during image loads."""


def route_first(page, url, handler):
    used = False

    def route(request):
        nonlocal used
        if used:
            request.continue_()
        else:
            used = True
            handler(request)

    # Expiring the last Playwright route can stall in-flight OHIF requests.
    page.route(url, route)
